# 开发计划 3 — 多 CLI 路由架构

> 创建日期：2026-04-05
> 前置：开发计划 2（Phase 4-7）已完成，单 Lead Agent 已跑通

---

## 架构进化

\
## 核心原则

**OpenClaw 坚决不拆解任务。** 它只做三件事：
1. 判断任务类型 -> 路由到哪个 CLI
2. 打开 / 关闭 CLI 进程
3. 把用户原话丢过去，不改、不拆、不加工

OpenClaw 的 token 消耗极低（只做分类），真正的 token 花在 CLI 里。

## 三个 CLI 角色定义

| CLI | 角色 | 常驻 | 适用场景 |
|-----|------|------|----------|
| **general** | 日常助手 | 是 | 文件读取、简单查询、系统状态、日常操作 |
| **code** | 代码工程师 | 按需 | 写代码、重构、测试、git、code review |
| **complex** | 深度分析师 | 按需 | 调研分析、多步骤任务、文档生成、项目审计 |

### General CLI（常驻）
- System Prompt：快速响应、不过度思考、处理大部分日常事务
- 工作目录：~/openclaw-backend/
- 特点：session 长期保持，积累项目上下文

### Code CLI（按需启动）
- System Prompt：严谨、考虑架构、写测试、code review
- 工作目录：按任务指定
- 特点：用完可关闭释放资源，下次启动时 --resume 恢复

### Complex CLI（按需启动）
- System Prompt：深度思考、全面分析、结构化输出
- 工作目录：按任务指定
- 特点：处理时间长，token 消耗大，用完即关

## OpenClaw 路由规则

\
简单判断标准：
- 纯聊天/问答 -> OpenClaw 自己处理
- 涉及文件但简单 -> General
- 涉及代码编写/修改 -> Code
- 多步骤/需要深度分析 -> Complex

---

## Harness 改造

### 从单会话到多会话

现有 lead-agent.js 管理 1 个 session。需要改造为管理 N 个命名 session。

#### 新模块：src/lib/cli-pool.js

\
#### 内部状态

\
### API 端点改造

| Method | Endpoint | 说明 |
|--------|----------|------|
| POST | /cli/start | 启动指定 CLI：{ name, cwd? } |
| POST | /cli/send | 发消息：{ name, message, timeout? } |
| POST | /cli/stop | 关闭：{ name } |
| GET | /cli/:name/status | 查询单个 CLI 状态 |
| GET | /cli/list | 列出所有 CLI 状态 |

向后兼容：保留 /task/submit（路由到 general CLI）。

### System Prompt 文件

\
---

## MCP Bridge 改造

现有 5 个工具 -> 扩展为支持多 CLI：

| 工具 | 说明 |
|------|------|
| submit_task | 改为：{ name: general/code/complex, message } |
| start_cli | 启动指定 CLI |
| stop_cli | 关闭指定 CLI |
| cli_status | 查询指定 CLI 状态 |
| cli_list | 列出所有 CLI |
| harness_health | 不变 |

## OpenClaw Skill 改造

SKILL.md v3 — 多 CLI 路由：

\
---

## 实施计划

### Phase 8 — CLI 池管理

| 任务 | 负责 | 内容 |
|------|------|------|
| P8-1 | backend-dev | **cli-pool.js**：多 CLI 会话管理（start/send/stop/list） |
| P8-2 | backend-dev | **System Prompts**：编写 general/code/complex 三个角色的 system.md |
| P8-3 | backend-dev | **新路由 /cli/***：注册到 server.js |
| P8-4 | backend-dev | **向后兼容**：/task/submit 默认路由到 general CLI |

\
### Phase 9 — MCP Bridge + Skill 升级

| 任务 | 负责 | 内容 |
|------|------|------|
| P9-1 | backend-dev | **MCP bridge v2**：harness_bridge.py 支持多 CLI 工具 |
| P9-2 | backend-dev | **Skill v3**：SKILL.md 多 CLI 路由规则 |
| P9-3 | backend-dev | **OpenClaw 配置更新**：重启容器加载新工具和 skill |

\
### Phase 10 — 测试 + 联调

| 任务 | 负责 | 内容 |
|------|------|------|
| P10-1 | test-writer | **cli-pool 测试**：fake-claude mock 多 CLI 场景 |
| P10-2 | backend-dev | **Mac mini 部署 + 联调**：完整链路 Telegram -> OpenClaw -> 3 CLI |

\
---

## 全局路线图

\
## 现有代码复用

| 模块 | 变化 |
|------|------|
| src/lib/lead-agent.js | **重构为 cli-pool.js**：从单会话变多会话 |
| src/lib/task-store.js | 不变：.tasks/ 仍然是 CLI 写入 |
| src/routes/task.js | 保留 + 新增 /cli/* 路由 |
| src/server.js | 新增路由注册 |
| .agents/lead/system.md | 拆分为 general/code/complex 三个 |

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| CLI 数量 | 最多 3 个 | 与 MAX_CONCURRENT=3 对齐 |
| CLI 生命周期 | general 常驻，其他按需 | 省资源省钱 |
| CLI 名称 | 固定三个 | OpenClaw 路由逻辑简单 |
| 任务拆解 | CLI 内部做 | OpenClaw 不拆解，保持薄层 |
| 向后兼容 | /task/submit 保留 | 不破坏现有集成 |

---

*架构方向由总架构师（人类）设计，实施方案由 Orchestrator（AI）细化。*
