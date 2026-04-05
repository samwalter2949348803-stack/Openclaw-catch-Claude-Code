English | [中文](README.zh.md)

# Openclaw Catch Claude Code

**The lobster shakes hands with Claude — small models command big models to do the work.**

> **Punching above its weight: unlock the full power of OpenClaw and Claude Code at minimal cost.**
>
> **Anthropic has restricted OpenClaw from using Claude subscriptions directly, and API calls are expensive.**
> **Our approach: use any cheap small model (GPT-mini, Gemini Flash, or even local Ollama)**
> **as a secretary on OpenClaw, dispatching tasks to Claude Code CLI — powered by the user's own CLI subscription.**
> **The secretary is cheap, the worker is powerful — that's how a small horse pulls a big cart.**
>
> **A humble contribution to the open-source AI movement.**

<p align="center">
  <img src="./picture.png" width="600" alt="Openclaw Catch Claude Code">
</p>

### Core Motivation

Anthropic restricted OpenClaw from using Claude subscriptions — a significant blow to the lobster community.
Calling the Claude API directly is painfully expensive.

But Claude Code CLI is an independent product — users subscribe and use it normally, unrelated to OpenClaw.

**We found a way: skip the API, use the CLI. Secretary runs on a small model, the real work runs on Claude.**

```
Traditional (expensive):  OpenClaw → Claude API      → every message burns money
Our approach (cheap):     OpenClaw → small model (nearly free) → Claude Code CLI (user's own subscription)
```

| Problem | Our Solution |
|---------|-------------|
| Claude API costs are high | Small model classifies (nearly free), CLI executes (user's existing subscription) |
| Anthropic restricts OpenClaw from Claude subscriptions | We use CLI, not API — no restrictions |
| Spoofing OAuth / bypassing auth — guaranteed ban | CLI is the user's own legitimate subscription, compliant usage, zero ban risk |
| Non-Claude models can't invoke MCP tools | Structured output routing — any model can drive CLI |
| OpenClaw can't execute commands or edit files directly | CLI agents have full system access |
| Single CLI session bottleneck | 3 specialized agents work in parallel |
| One-size-fits-all config | Each agent has its own `.claude/` workspace, fully customizable |

## Core Features

- **Multi-CLI pool** -- 3 specialized agents (general / code / complex), each an independent Claude Code CLI process
- **Per-agent workspaces** -- `.cli-workspaces/{name}/` with full `.claude/` customization (CLAUDE.md, settings.json, rules, subagents)
- **Structured output routing** -- `[routing: general|code|complex]` tags drive automatic dispatch, works with any model
- **OpenClaw integration** -- HTTP-to-CLI bridge + Telegram via hooks
- **Custom scheduled tasks** -- cron / interval / one-shot scheduling
- **Fully customize your lobster** -- OpenClaw's SOUL.md, AGENTS.md, BOOTSTRAP.md, Skills, and Hooks are all open for customization — build your own AI assistant personality and workflow
- **Session persistence** -- atomic writes + schema validation + token usage tracking
- **138 tests, zero external dependencies** -- Node.js 18+ built-in APIs only
- **Zero ban risk**

## Project Structure

```
server.js                     -- Entry point (delegates to src/server.js)
src/
  server.js                   -- HTTP server, routing, auth, CORS
  routes/
    cli.js                    -- CLI pool endpoints (/cli/*)
    task.js                   -- Task management endpoints (/task/*, /tasks/*, /lead/*)
    session.js                -- Named session endpoints (/session/*)
    claude.js                 -- Claude CLI endpoints (/connect, /sessions, /resume, etc.)
    tools.js                  -- Direct tool endpoints (/bash, /read, /call, /batch-read)
  lib/
    cli-pool.js               -- Multi-CLI pool (general/code/complex)
    claude-runner.js           -- Claude CLI process management, SSE streaming, concurrency
    session-store.js           -- Session persistence (atomic writes, schema validation)
    task-store.js              -- Task state persistence
    helpers.js                 -- JSON response, body parsing, CLI arg building
    logger.js                  -- Structured logging (controlled by LOG_LEVEL)
openclaw/
  docker-compose.yml           -- OpenClaw deployment config
  openclaw.json.example        -- OpenClaw config template
  AGENTS.md                    -- Agent role definitions
  SKILL.md                     -- Skill configuration
  BOOTSTRAP.md                 -- Bootstrap prompt
  hooks/cli-router/            -- Message routing hook
  mcp/                         -- HTTP-to-CLI bridge config
  claude_setting_example/      -- .claude/ config examples for all 3 agents
test/
  helpers.test.js              -- Helper utility unit tests
  server.test.js               -- HTTP endpoint integration tests
  lead-agent.test.js           -- Lead agent / task routing tests
  cli-pool.test.js             -- CLI pool tests
  fake-claude.js               -- Claude CLI mock for testing
docs/
  openapi.yaml                 -- OpenAPI 3.0 spec
  cron-guide.md                -- Scheduled tasks guide
```

## Quick Start

### Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

### Install and run

```bash
git clone https://github.com/samwalter2949348803-stack/Openclaw-catch-Claude-Code.git
cd Openclaw-catch-Claude-Code
node server.js
```

Server listens on `http://127.0.0.1:18795` (localhost only).

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `18795` | HTTP server port |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI binary |
| `DEFAULT_CWD` | `/root` | Default working directory for CLI processes |
| `AUTH_TOKEN` | *(empty)* | When set, all prefixed endpoints require `Authorization: Bearer <token>` |
| `MAX_CONCURRENT` | `3` | Maximum concurrent Claude CLI processes |
| `LOG_LEVEL` | `INFO` | Minimum log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LEAD_TIMEOUT` | `300` | Default CLI send timeout (seconds) |
| `BASH_DISABLED` | *(empty)* | Set to `true` to disable the `/bash` endpoint (returns 403) |
| `BASH_ALLOWED_COMMANDS` | *(empty)* | Comma-separated whitelist of allowed commands (e.g., `ls,cat,grep`) |

## API Endpoints

All endpoints (except `/health`) are prefixed with `/backend-api/claude-code`.

Example: `POST http://localhost:18795/backend-api/claude-code/cli/send`

### Health Check

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server uptime, active sessions, process count (no prefix, no auth) |

### CLI Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/cli/start` | Start a named CLI session (general / code / complex) |
| `POST` | `/cli/send` | Send message to a CLI (auto-starts if not running) |
| `POST` | `/cli/stop` | Stop a named CLI session |
| `GET` | `/cli/list` | List all CLI sessions in the pool |
| `GET` | `/cli/:name/status` | Get status of a specific CLI session |

### Task Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/task/submit` | Submit a task to the lead agent |
| `GET` | `/task/:taskId/status` | Query task status by ID |
| `GET` | `/tasks/list` | List all tasks |
| `POST` | `/task/:taskId/cancel` | Cancel a running task |
| `POST` | `/lead/restart` | Restart the lead agent |
| `GET` | `/lead/status` | Get lead agent status |

### Session Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/session/start` | Create a named session (spawns Claude process, stores session ID) |
| `POST` | `/session/send` | Send message to a named session |
| `POST` | `/session/send-stream` | Send message with SSE streaming output |
| `GET` | `/session/list` | List all active named sessions |
| `POST` | `/session/stop` | Remove a named session |
| `POST` | `/session/status` | Get session details, token usage, uptime |
| `POST` | `/session/restart` | Restart a failed or stale session |
| `POST` | `/session/history` | Get conversation history (paginated) |

### Tools

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/bash` | Execute shell command (with safety controls) |
| `POST` | `/read` | Read a file from disk |
| `POST` | `/call` | Execute Glob, Grep, or Read directly |
| `POST` | `/batch-read` | Batch-read files by glob pattern |
| `GET` | `/tools` | List available Claude Code tools |

### Connection

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/connect` | Check connectivity, return tool count |
| `POST` | `/disconnect` | Notify client disconnection |
| `GET` | `/sessions` | List JSONL session files on disk |
| `POST` | `/resume` | Resume a Claude session by session ID |
| `POST` | `/continue` | Continue the most recent Claude session |

## CLI Agent Workspaces

Each CLI agent (general, code, complex) can have its own workspace at `.cli-workspaces/{name}/`.
When a CLI starts, the harness automatically detects the directory and uses it as the working directory.

A workspace can contain:

- `CLAUDE.md` -- agent-specific project instructions
- `.claude/settings.json` -- local config and hooks
- `.claude/rules/` -- additional rule files
- `.claude/agents/` -- subagent definitions

See [`openclaw/claude_setting_example/README.md`](openclaw/claude_setting_example/README.md) for complete examples of all three agent configurations.

## OpenClaw Integration

OpenClaw is the external orchestration layer that connects Telegram users to this harness.

- **Hooks** -- The `message:sent` hook in `openclaw/hooks/cli-router/` intercepts messages with `[routing: agent]` tags and forwards them to the corresponding CLI endpoint
- **Telegram** -- Users interact via Telegram; OpenClaw classifies messages and tags them for routing
- **Config** -- See `openclaw/docker-compose.yml` and `openclaw/openclaw.json.example` for deployment setup
- **Agent roles** -- See `openclaw/AGENTS.md` for role definitions
- **Skills** -- See `openclaw/SKILL.md` for skill configuration
- **Bootstrap** -- See `openclaw/BOOTSTRAP.md` for initialization flow

## Scheduled Tasks

OpenClaw's built-in cron scheduler supports three scheduling modes:

- **Cron expressions** -- `--cron "0 10 * * *"` for precise scheduling
- **Fixed intervals** -- `--every "30m"` for periodic checks
- **One-shot** -- `--at "5m"` for delayed execution

Results can be pushed to Telegram. Messages containing `[routing: xxx]` tags are automatically dispatched to the corresponding CLI agent.

Full configuration guide: [`openclaw/cron-guide.md`](openclaw/cron-guide.md).

## How It Works (30-second version)

1. You send a message via Telegram
2. OpenClaw's model classifies it: `Processing your request... [routing: code] write unit tests`
3. The `message:sent` hook intercepts the routing tag
4. The hook calls the harness API (`POST /cli/send`)
5. The harness dispatches to the `code` CLI agent
6. Claude Code CLI executes the task with full file system access
7. The result is sent back to you via Telegram Bot API

**The model only classifies. The CLI does all the real work.**

## Testing

```bash
npm test
```

138 tests using Node.js built-in test runner (`node --test`). Includes a Claude CLI mock (`test/fake-claude.js`) — no real Claude environment needed to run tests.

## Acknowledgments

- [OpenClaw](https://github.com/openclaw/openclaw) — bringing AI agents into everyone's life
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's powerful coding CLI
- All developers contributing to the open-source AI ecosystem

## License

[MIT](LICENSE) — free to use, modify, and distribute.

If this project helps you, consider giving it a star or submitting a PR to help improve it.
