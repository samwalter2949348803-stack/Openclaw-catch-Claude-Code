[English](README.md) | 中文

# Openclaw Catch Claude Code

基于 Claude Code CLI 的多 agent 任务编排 harness，集成 OpenClaw 调度层。

## 架构

```
User (Telegram) --> OpenClaw (classifier) --> [routing: agent] tag
                                                    |
                                          message:sent hook
                                                    |
                                          Harness (Node.js) --> CLI Pool
                                                    |
                              +----------+----------+----------+
                              | general  |   code   | complex  |
                              |   CLI    |   CLI    |   CLI    |
                              +----------+----------+----------+
```

OpenClaw 对 Telegram 收到的消息进行分类，并附加 `[routing: agent]` 标签。
`message:sent` hook 将带标签的消息转发到本 harness，由 harness 分派给 CLI agent 池中对应的 agent。

## 核心功能

- **多 CLI 池** -- 3 个专用 agent（general / code / complex），每个都是长驻的 Claude Code CLI 进程
- **独立 agent 工作区** -- `.cli-workspaces/{name}/`，支持完整的 `.claude/` 自定义配置（CLAUDE.md、settings.json、rules、subagents）
- **结构化输出路由** -- `[routing: general|code|complex]` 标签驱动自动分派
- **OpenClaw 集成** -- HTTP-to-CLI 桥接 + 通过 OpenClaw hook 对接 Telegram
- **定时任务** -- 通过 OpenClaw 内置调度器支持 cron、interval 和 one-shot 三种调度模式
- **会话持久化** -- 原子化 JSON 写入，带 schema 校验，按会话追踪 token 用量
- **结构化日志** -- 可配置日志级别（DEBUG / INFO / WARN / ERROR）
- **138 个测试，零外部依赖** -- 仅使用 Node.js 18+ 内置 API
- **GitHub Actions CI** -- push 时自动运行测试

## 快速开始

### 前置要求

- Node.js 18+
- 已安装并完成认证的 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### 安装与运行

```bash
git clone https://github.com/samwalter2949348803-stack/Openclaw-catch-Claude-Code.git
cd Openclaw-catch-Claude-Code
node server.js
```

服务启动后监听 `http://127.0.0.1:18795`（仅本地访问）。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `18795` | HTTP 服务端口 |
| `CLAUDE_BIN` | `claude` | Claude Code CLI 二进制文件路径 |
| `DEFAULT_CWD` | `/root` | CLI 进程的默认工作目录 |
| `AUTH_TOKEN` | *(空)* | 设置后，所有带前缀的端点需要 `Authorization: Bearer <token>` 认证 |
| `MAX_CONCURRENT` | `3` | 最大并发 Claude CLI 进程数 |
| `LOG_LEVEL` | `INFO` | 最低日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR` |
| `LEAD_TIMEOUT` | `300` | 默认 CLI 发送超时时间（秒） |
| `BASH_DISABLED` | *(空)* | 设为 `true` 可禁用 `/bash` 端点（返回 403） |
| `BASH_ALLOWED_COMMANDS` | *(空)* | 允许执行的命令白名单，逗号分隔（如 `ls,cat,grep`） |

## API 端点

所有端点（`/health` 除外）均带有前缀 `/backend-api/claude-code`。

示例：`POST http://localhost:18795/backend-api/claude-code/cli/send`

### 健康检查

| 方法 | 端点 | 说明 |
|---|---|---|
| `GET` | `/health` | 服务运行时长、活跃会话数、进程数（无前缀，无需认证） |

### CLI 管理

| 方法 | 端点 | 说明 |
|---|---|---|
| `POST` | `/cli/start` | 启动指定名称的 CLI 会话（general / code / complex） |
| `POST` | `/cli/send` | 向指定 CLI 发送消息（未运行时自动启动） |
| `POST` | `/cli/stop` | 停止指定 CLI 会话 |
| `GET` | `/cli/list` | 列出池中所有 CLI 会话 |
| `GET` | `/cli/:name/status` | 获取指定 CLI 会话状态 |

### 任务管理

| 方法 | 端点 | 说明 |
|---|---|---|
| `POST` | `/task/submit` | 向 lead agent 提交任务 |
| `GET` | `/task/:taskId/status` | 根据任务 ID 查询状态 |
| `GET` | `/tasks/list` | 列出所有任务 |
| `POST` | `/task/:taskId/cancel` | 取消正在运行的任务 |
| `POST` | `/lead/restart` | 重启 lead agent |
| `GET` | `/lead/status` | 获取 lead agent 状态 |

### 会话管理

| 方法 | 端点 | 说明 |
|---|---|---|
| `POST` | `/session/start` | 创建命名会话（启动 Claude 进程，存储 session ID） |
| `POST` | `/session/send` | 向命名会话发送消息 |
| `POST` | `/session/send-stream` | 发送消息并以 SSE 流式输出 |
| `GET` | `/session/list` | 列出所有活跃的命名会话 |
| `POST` | `/session/stop` | 移除命名会话 |
| `POST` | `/session/status` | 获取会话详情、token 用量、运行时长 |
| `POST` | `/session/restart` | 重启失败或过期的会话 |
| `POST` | `/session/history` | 获取对话历史（支持分页） |

### 工具

| 方法 | 端点 | 说明 |
|---|---|---|
| `POST` | `/bash` | 执行 shell 命令（带安全控制） |
| `POST` | `/read` | 从磁盘读取文件 |
| `POST` | `/call` | 直接执行 Glob、Grep 或 Read 操作 |
| `POST` | `/batch-read` | 按 glob 模式批量读取文件 |
| `GET` | `/tools` | 列出可用的 Claude Code 工具 |

### 连接

| 方法 | 端点 | 说明 |
|---|---|---|
| `POST` | `/connect` | 检查连通性，返回工具数量 |
| `POST` | `/disconnect` | 通知客户端断开连接 |
| `GET` | `/sessions` | 列出磁盘上的 JSONL 会话文件 |
| `POST` | `/resume` | 根据 session ID 恢复 Claude 会话 |
| `POST` | `/continue` | 继续最近一次 Claude 会话 |

## CLI Agent 工作区

每个 CLI agent（general、code、complex）可以在 `.cli-workspaces/{name}/` 下拥有专属工作区。
当 CLI 启动时，harness 会自动检测该目录是否存在，并将其作为工作目录。

工作区可包含：

- `CLAUDE.md` -- agent 专属的项目指令
- `.claude/settings.json` -- 本地配置与 hook
- `.claude/rules/` -- 额外的规则文件
- `.claude/agents/` -- subagent 定义

完整示例参见 [`openclaw/claude_setting_example/README.md`](openclaw/claude_setting_example/README.md)，包含全部三个 agent 的配置。

## OpenClaw 集成

OpenClaw 是外部编排层，负责将 Telegram 用户连接到本 harness。

- **Hooks** -- `openclaw/hooks/cli-router/` 中的 `message:sent` hook 拦截带有 `[routing: agent]` 标签的消息，并转发到对应的 CLI 端点
- **Telegram** -- 用户通过 Telegram 交互；OpenClaw 对消息分类并打标签用于路由
- **配置** -- 部署设置参见 `openclaw/docker-compose.yml` 和 `openclaw/openclaw.json.example`
- **Agent 角色** -- 角色定义参见 `openclaw/AGENTS.md`
- **Skills** -- 技能配置参见 `openclaw/SKILL.md`
- **引导流程** -- 初始化流程参见 `openclaw/BOOTSTRAP.md`

## 定时任务

OpenClaw 内置的 cron 调度器支持三种调度模式：

- **Cron 表达式** -- `--cron "0 10 * * *"` 精确定时
- **固定间隔** -- `--every "30m"` 周期性检查
- **一次性执行** -- `--at "5m"` 延迟触发

执行结果可推送到 Telegram。消息中包含 `[routing: xxx]` 标签的内容会自动分派到对应的 CLI agent。

完整配置指南参见 [`openclaw/cron-guide.md`](openclaw/cron-guide.md)。

## 项目结构

```
server.js                     -- 入口文件（委托给 src/server.js）
src/
  server.js                   -- HTTP 服务、路由分派、认证、CORS
  routes/
    cli.js                    -- CLI 池端点（/cli/*）
    task.js                   -- 任务管理端点（/task/*、/tasks/*、/lead/*）
    session.js                -- 命名会话端点（/session/*）
    claude.js                 -- Claude CLI 端点（/connect、/sessions、/resume 等）
    tools.js                  -- 直接工具端点（/bash、/read、/call、/batch-read）
  lib/
    cli-pool.js               -- 多 CLI 池（general/code/complex）
    claude-runner.js           -- Claude CLI 进程管理、SSE 流式输出、并发控制
    session-store.js           -- 会话持久化（原子写入、schema 校验）
    task-store.js              -- 任务状态持久化
    helpers.js                 -- JSON 响应、请求体解析、CLI 参数构建
    logger.js                  -- 结构化日志（受 LOG_LEVEL 控制）
openclaw/
  docker-compose.yml           -- OpenClaw 部署配置
  openclaw.json.example        -- OpenClaw 配置示例
  AGENTS.md                    -- Agent 角色定义
  SKILL.md                     -- 技能配置
  BOOTSTRAP.md                 -- 初始化引导流程
  hooks/cli-router/            -- 消息路由 hook
  mcp/                         -- HTTP-to-CLI 桥接配置
  claude_setting_example/      -- 3 个 agent 的 .claude/ 配置示例
test/
  helpers.test.js              -- helper 工具函数单元测试
  server.test.js               -- HTTP 端点集成测试
  lead-agent.test.js           -- Lead agent / 任务路由测试
  cli-pool.test.js             -- CLI 池测试
  fake-claude.js               -- 用于测试的 Claude CLI mock
docs/
  openapi.yaml                 -- OpenAPI 3.0 规范
  cron-guide.md                -- 定时任务指南
```

## 测试

```bash
npm test
```

共 138 个测试。使用 Node.js 内置测试运行器（`node --test`）。内含 Claude CLI mock（`test/fake-claude.js`），无需真实 Claude 环境即可运行测试。

## 许可证

MIT
