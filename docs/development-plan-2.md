# 开发计划 2 — Lead Agent 架构

> 创建日期：2026-04-05
> 前置：开发计划 1（Phase 0-3）已全部完���

---

## 核心问题

OpenClaw 通过 Claude API 理解用户意图（秘书），Claude Code CLI 执行实际编码（干活的）。
我们的 harness 是中间桥梁，但目前它只是个**笨管道**：

```
OpenClaw（秘书）-> harness（转发） -> CLI（干活） -> harness（转发） -> "改好了"
```

秘书不知道工人改了哪些文件、花了多少 token、能不能重试、该不该复用上次的会话。
所有让秘书变聪明的信息，都在 harness 这一层**丢掉了**。

### 错误的方向

试图在 harness（Node.js 代码）里重建 CLI 已有的能力：任务拆解、变更追踪、会话选择……
这是用代码模拟 AI，本末倒置。

### 正确的方向

**把智能留给 AI（CLI），把调度留给代码（harness）。**

指派一个 Lead Agent CLI 会话作为施工队长，它天生具备：
- 理解任务、拆解子任务（AI 原生能力）
- 分发子 agent / worker（CLI 原生 Agent 工具）
- 读写文件追踪状态（CLI 原生 Write/Read/Bash 工具）
- 上下文管理（CLI session 历史 = 身份记忆）

| 当前 Harness 职责               | CLI 能自己干吗？                                | 结论             |
| ------------------------------- | ----------------------------------------------- | ---------------- |
| spawn Lead Agent 进程           | 不能，需要外部启动它                            | **Harness 保留** |
| 监控 Lead Agent 进程生死        | 不能，自己不知道自己挂了                        | **Harness 保留** |
| Lead 挂了通知 OpenClaw          | 不能，已经死了                                  | **Harness 保留** |
| HTTP API 给 OpenClaw 提交任务   | 不能，CLI 不是 HTTP 服务器                      | **Harness 保留** |
| HTTP API 给 OpenClaw 查任务状态 | 不能，同上                                      | **Harness 保留** |
| ~~文件监听 inbox 变化~~         | Lead Agent 自己派发 subagent，不需要 inbox 轮询 | **砍掉**         |
| ~~写 inbox.jsonl 触发 Worker~~  | Lead Agent 用 Agent 工具直接 spawn              | **砍掉**         |
| ~~Worker 进程管理~~             | CLI subagent 原生管理                           | **砍掉**         |
| ~~变更回收 git diff~~           | Lead Agent/Worker 自己会 git diff               | **砍掉**         |
| ~~Worktree 创建~~               | CLI 原生 `--worktree` 参数                      | **砍掉**         |
| ~~Worktree 合并~~               | Lead Agent 自己可以 `git merge`                 | **砍掉**         |
| ~~文件锁~~                      | 只有 CLI 在写 .tasks/，不存在并发               | **砍掉**         |

---

## 目标架构

```
你（人类）
    |  自然语言对话
    v
OpenClaw 接收、理解
    |
    v
Lead Agent（Claude CLI 交互会话）
  - 理解需求，拆分任务
  - 根据专长分配 assignee
  - 直接用 Write/Bash 工具写磁盘:
      .tasks/task_N.json
      .agents/<id>/inbox.jsonl
    |
    v  写文件（工具调用）
共享磁盘状态
  .tasks/      <- 任务板（谁做什么，什么状态）
  .agents/     <- 注册表 + 各 Agent 邮箱
  .worktrees/  <- 隔离的代码工作目录
    |
    v  检测文件变化
Harness（后台调度器）
  - 监听 .agents/*/inbox.jsonl 变化
  - 有新消息 -> spawn CLI 进程
  - 监听 .tasks/*.json 状态变化 -> 推送给 OpenClaw
  - 管理进程生命周期（崩溃检测、重启、超时）
    |
    v  触发 CLI 进程
+------------------+   +------------------+
|   Bob (后端)     |   |   Alice (前端)    |  <- 各自独立的 CLI 进程
|  --resume <sid>  |   |  --resume <sid>  |
|  --worktree bob  |   |  --worktree alice|
|  - 记得自己是Bob  |   |  - 记得自己是Alice|  <- 会话历史 = 身份
|  - 写代码        |   |  - 写前端         |
|  - 直接更新磁盘   |   |  - 直接更新磁盘   |  <- 完成后写任务板
+------------------+   +------------------+
```

### 角色分工

| 角色 | 是什么 | 做什么 | 不做什么 |
|------|--------|--------|----------|
| **OpenClaw** | Claude API 秘书 | 接收用户意图，翻译成任务描述，传给 Lead Agent | 不拆解子任务、不管工人 |
| **Lead Agent** | Claude CLI 常驻会话 | 理解任务、拆子任务、写 .tasks/ 和 inbox、验收结果 | 不直接写业务代码 |
| **Harness** | Node.js 调度器 | 监听文件变化、spawn/kill CLI 进程、状态上报 | 不理解任务内容 |
| **Workers** | Claude CLI 独立会话 | 在 worktree 里写代码、完成后更新任务状态 | 不互相通信（通过任务板间接协调） |

---

## 实施计划

### Harness 极简化原则

**CLI 能干的事，Harness 不介入。**

Lead Agent 是常驻 CLI 进程，Worker 是 Lead Agent 的 subagent（CLI 原生 Agent 工具）。
因此：任务拆解、Worker 派发、worktree 管理、git diff、文件协调——全部是 CLI 内部事务。

Harness 只做 CLI 做不到的事：

```
1. 启动 Lead Agent CLI 进程
2. 监控 Lead Agent 进程生死
3. Lead 挂了 -> 通知 OpenClaw
4. HTTP API：接收 OpenClaw 任务 -> 传给 Lead Agent
5. HTTP API：OpenClaw 查询状态 -> 读 .tasks/ 返回
```

---

### Phase 4 — Lead Agent 进程管理

> Harness 的核心：启动、监控、传话

| 任务 | 负责 | 内容 |
|------|------|------|
| P4-1 | backend-dev | **Lead Agent 启动器**：spawn 常驻 CLI 进程，注入 system prompt，保存 session ID |
| P4-2 | backend-dev | **进程监控**：监听 Lead Agent 进程退出事件，区分正常/异常退出 |
| P4-3 | backend-dev | **OpenClaw 通知**：Lead 异常退出时，通过回调 URL / 状态文件通知 OpenClaw |

#### P4-1 启动器设计

```javascript
// src/lib/lead-agent.js
// 启动 Lead Agent 常驻 CLI 进程
function startLeadAgent(systemPromptPath, cwd) {
  const child = spawn(CLAUDE_BIN, [
    "-p", fs.readFileSync(systemPromptPath, "utf8"),
    "--output-format", "json",
    "--cwd", cwd
  ]);
  // 保存 session ID（从首次响应中提取）
  // 后续用 --resume <sid> 恢复
}

// 向 Lead Agent 发送消息（恢复会话）
function sendToLead(sessionId, message) {
  return runClaude([
    "-p", message,
    "--resume", sessionId,
    "--output-format", "json"
  ]);
}
```

```
执行顺序：P4-1 -> P4-2 -> P4-3（串行）
```

### Phase 5 — Lead Agent 角色定义

> 告诉 Lead Agent 它是谁、协议是什么

| 任务 | 负责 | 内容 |
|------|------|------|
| P5-1 | backend-dev | **system.md 编写**：Lead Agent 的角色定义 + 磁盘协议 + 任务板 schema |
| P5-2 | backend-dev | **磁盘协议初始化**：创建 .tasks/, .agents/ 目录结构 |

#### P5-1 system.md 核心内容

```markdown
# 你是 Lead Agent（施工队长）

## 你的环境
- 你运行在 Claude Code CLI 中，拥有 Write/Read/Edit/Bash/Agent 等所有工具
- 你有持久会话（--resume），你记得之前所有对话
- 你可以用 Agent 工具派发 subagent（Worker）到独立 worktree 干活

## 你收到任务后
1. 理解需求，判断复杂度
2. 简单任务：自己直接做
3. 复杂任务：用 Agent 工具派发 Worker，设置 isolation: worktree
4. 把任务状态写入 .tasks/task_N.json
5. 完成后更新 task 状态为 done，写入 result

## 你不做什么
- 不直接写业务代码（复杂任务交给 Worker）
- 不调用 HTTP API（一切通过文件系统和 CLI 工具）

## .tasks/ 文件格式
[附 task schema]
```

```
执行顺序：P5-1 -> P5-2（串行）
```

### Phase 6 — OpenClaw 集成 API

> OpenClaw 通过 HTTP 提交任务、查询状态

| 任务 | 负责 | 内容 |
|------|------|------|
| P6-1 | backend-dev | **POST /task/submit**：写入任务 -> sendToLead() -> 返回 taskId |
| P6-2 | backend-dev | **GET /task/:id/status**：读 .tasks/task_:id.json 返回状态 |
| P6-3 | backend-dev | **GET /tasks/list**：读 .tasks/ 目录，返回所有任务概览 |
| P6-4 | backend-dev | **POST /task/:id/cancel**：kill Lead Agent 当前执行（如果正在处理该任务） |

#### 核心流程

```
OpenClaw POST /task/submit { "message": "帮我修登录 bug" }
  -> Harness 调用 sendToLead(sessionId, message)
  -> Lead Agent CLI 启动，理解任务
  -> Lead Agent 写 .tasks/task_001.json（status: in_progress）
  -> Lead Agent 派发 Worker subagent（如果需要）
  -> Worker 完成，Lead Agent 更新 task（status: done, result: {...}）
  -> runClaude 返回，Harness 拿到结果
  -> Harness 返回给 OpenClaw
```

```
执行顺序：P6-1 -> P6-2, P6-3 并行 -> P6-4
```

### Phase 7 — 健壮性 + 测试

| 任务 | 负责 | 内容 |
|------|------|------|
| P7-1 | backend-dev | **Lead Agent 崩溃上报**：进程异常退出 -> 通知 OpenClaw |
| P7-2 | backend-dev | **Lead Agent 会话恢复**：OpenClaw 请求重启时，用 --resume 恢复 session |
| P7-3 | backend-dev | **超时保护**：单次 sendToLead 支持超时，超时 kill 并上报 |
| P7-4 | test-writer | **端到端测试**：fake-claude mock Lead Agent 正常 + 崩溃场景 |

```
执行顺序：P7-1, P7-2, P7-3 并行 -> P7-4
```

---

## 全局路线图

```
已完成                            下一步
Phase 0 清理            done      Phase 4 Lead Agent 进程管理  <- 启动+监控
Phase 1 稳固            done      Phase 5 Lead Agent 角色定义  <- system prompt
Phase 2 补全            done      Phase 6 OpenClaw 集成 API    <- 提交+查询
Phase 3 体验            done      Phase 7 健壮性 + 测试        <- 崩溃恢复+测试
```



## 现有代码的复用

| 已有模块 | 在新架构中的角色 |
|----------|------------------|
| src/lib/claude-runner.js | **核心复用**：sendToLead 直接用 runClaude |
| src/lib/logger.js | 全局日志 |
| src/lib/helpers.js | buildClaudeArgs 构建 CLI 参数 |
| src/server.js | HTTP 层 + Auth + 新增 /task/* 路由 |
| test/ | 扩展覆盖 Lead Agent 场景 |

## 关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Lead Agent 生命周期 | **常驻** | session 历史 = 身份记忆，冷启动成本高 |
| Worker 管理 | **CLI 原生** | Agent 工具 + worktree isolation，不需要 harness 介入 |
| 任务传递 | **同步调用** | sendToLead 等待 CLI 返回，简单可靠 |
| 进度查询 | **读任务板** | .tasks/ 目录是 single source of truth |
| Harness 角色 | **HTTP 网关 + 进程保姆** | 只做 CLI 做不到的事 |

## 开源价值定位

> **Claude Code 的多 Agent 编排框架 — 极简版**
>
> Harness 只做两件事：HTTP 网关（接收任务、返回结果）+ 进程保姆（启动、监控 Lead Agent）。
> 所有智能在 CLI 里：Lead Agent 理解任务、派发 Worker、追踪变更、验收结果。
> .tasks/ 目录是唯一的状态中心，可见、可调试、可恢复。


---

*架构方向由总架构师（人类）设计，实施方案由 Orchestrator（AI）细化。*
