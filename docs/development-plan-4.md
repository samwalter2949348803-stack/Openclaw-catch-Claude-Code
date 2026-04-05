# 开发计划 4 — 结构化输出分流 + 定时任务

> 创建日期：2026-04-05
> 前置：Plan 3 已完成，联调发现非 Claude 模型不会主动调用 MCP 工具
> 更新：v3 — 基于 message:sent hook 实现

---

## 核心洞察

非 Claude 模型不会调 MCP 工具，但**任何模型都能格式化输出**。

不让模型调工具，让它输出分类结果，我们通过 `message:sent` hook 读取并执行。

---

## 架构

```
用户（Telegram）
    |
    v
OpenClaw 模型（任何模型）
  System Prompt 要求输出分类格式：
  "正在为你处理... [routing: code] 原始消息"
  或直接回复（简单问候）
    |
    v
消息发到 Telegram（用户看到"正在处理..."）
    |
    v
message:sent hook 触发
    |
    +-- 检测到 [routing: xxx] 标记？
    |     YES → 解析 agent + task
    |           → HTTP POST /cli/send
    |           → CLI 执行
    |           → 发送新消息到 Telegram（执行结果）
    |
    +-- 没有标记？
          → 普通回复，不处理
```

### 为什么用标记而不是 JSON

- 用户看到 `正在为你处理... [routing: code]` 是可读的
- 用户看到 `{"action":"cli","agent":"code"}` 很丑
- hook 解析 `[routing: xxx]` 比解析 JSON 更简单可靠
- 模型不需要输出严格 JSON（容易出格式错误），只需要在回复里包含标记

### 消息流程示例

用户："帮我看看 server.js 的代码结构"

1. 模型输出（发到 Telegram）：
   `正在为你处理... [routing: general] 帮我看看 server.js 的代码结构`

2. message:sent hook 检测到 `[routing: general]`

3. hook 调用 `POST /cli/send { name: "general", message: "帮我看看 server.js 的代码结构" }`

4. CLI 执行，返回结果

5. hook 发送新消息到 Telegram：
   `server.js 是薄入口（6行），实际逻辑在 src/server.js...`

用户："你好"

1. 模型输出（发到 Telegram）：
   `你好！有什么可以帮你的？`

2. hook 没检测到 `[routing: xxx]` → 不处理

---

## 模型 System Prompt

```
你是一个任务路由器 + 助手。

收到用户消息后判断：

1. 如果是简单问候或闲聊（你好、谢谢、再见等），直接回复，不加任何标记。

2. 如果需要执行任何操作（读文件、写代码、跑命令、做分析等），回复以下格式：
   正在为你处理... [routing: <agent>] <用户原始消息>

   agent 选择：
   - general：文件读取、查询、系统操作、日常任务
   - code：写代码、重构、测试、git 操作
   - complex：调研、分析、报告、多步骤任务

   <用户原始消息> 必须是用户说的原话，不要改写。

示例：
用户："帮我看 server.js"
回复：正在为你处理... [routing: general] 帮我看 server.js

用户："重构认证模块"
回复：正在为你处理... [routing: code] 重构认证模块

用户："你好"
回复：你好！有什么可以帮你的？
```

---

## Hook 实现

### hook 目录结构

```
~/.openclaw/hooks/cli-router/
  HOOK.md       <- hook 定义（事件订阅）
  handler.ts    <- 处理逻辑
```

### HOOK.md

```yaml
---
name: cli-router
description: Intercept model output with [routing:] tags, execute via CLI, send result back
events:
  - message:sent
---
```

### handler.ts

```typescript
const HARNESS = "http://host.docker.internal:18795/backend-api/claude-code";
const ROUTING_REGEX = /\[routing:\s*(general|code|complex)\]\s*(.*)/s;

const handler = async (event) => {
  const text = event.text || event.message?.text || "";
  const match = text.match(ROUTING_REGEX);
  
  if (!match) return; // 普通回复，不处理
  
  const agent = match[1];
  const task = match[2].trim();
  
  try {
    // 调用 harness CLI
    const resp = await fetch(`${HARNESS}/cli/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agent, message: task }),
    });
    const result = await resp.json();
    
    if (result.ok && result.response) {
      event.messages.push(result.response);
    } else {
      event.messages.push(`执行失败：${result.error || "未知错误"}`);
    }
  } catch (err) {
    event.messages.push(`CLI 连接失败：${err.message}`);
  }
};

export default handler;
```

---

## 定时任务

### 完美适配

```
OpenClaw heartbeat 触发
  prompt: "检查系统状态"
    |
    v
模型输出："正在为你处理... [routing: general] 检查系统状态"
    |
    v
message:sent hook → 解析 → cli_send → CLI 执行 → 结果发回
```

和交互消息走同一条路，零额外设计。

### heartbeat 配置

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "every": "30m",
        "prompt": "检查系统状态，报告异常"
      }
    }
  }
}
```

---

## Claude 模型兼容性

Claude 模型有两条路可走：

1. **走 MCP 路径**（保留）：Claude 自主调用 cli_send → 直接执行
2. **走标记路径**（新增）：Claude 也输出 [routing:] 标记 → hook 执行

两条路都能工作。如果 system prompt 要求输出标记，Claude 也会遵守——统一流程。

建议：**统一走标记路径**，不分模型，架构最简单。

---

## 实施计划

### Phase 11 — 结构化输出分流

| 任务 | 负责 | 内容 |
|------|------|------|
| P11-1 | backend-dev | **System Prompt**：更新 AGENTS.md，要求模型输出 [routing:] 标记 |
| P11-2 | backend-dev | **cli-router hook**：创建 HOOK.md + handler.ts，解析标记调 cli_send |
| P11-3 | backend-dev | **部署到 Mac mini**：hook 文件放入 Docker volume，重启 OpenClaw |
| P11-4 | backend-dev | **Telegram 联调**：验证完整链路 |

```
执行顺序：P11-1 + P11-2 并行 → P11-3 → P11-4
```

### Phase 12 — 定时任务

| 任务 | 负责 | 内容 |
|------|------|------|
| P12-1 | backend-dev | **heartbeat 配置**：设置定时 prompt |
| P12-2 | backend-dev | **验证**：定时消息走 [routing:] → hook → cli_send 链路 |

```
执行顺序：P12-1 → P12-2
```

---

## 全局路线图

```
已完成                              下一步
Plan 1 (Phase 0-3)     done        Phase 11 结构化输出分流
Plan 2 (Phase 4-7)     done        Phase 12 定时任务
Plan 3 (Phase 8-10)    done
```

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 输出格式 | [routing: agent] 标记 | 人类可读 + 易解析，比 JSON 更友好 |
| hook 时机 | message:sent | 唯一可用的输出后 hook |
| 分类方式 | 模型语义理解 | 比关键词匹配准确，任何模型都能做 |
| 模型差异处理 | 统一走标记路径 | 不分 Claude/非Claude，架构最简 |

---

*架构方向由总架构师（人类）设计，实施方案由 Orchestrator（AI）细化。*
