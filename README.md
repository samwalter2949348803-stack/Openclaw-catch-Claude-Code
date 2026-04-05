English | [中文](README.zh.md)

# Openclaw Catch Claude Code

Multi-agent task orchestration harness for Claude Code CLI, with OpenClaw integration.

> **The missing orchestration layer between OpenClaw and Claude Code CLI.**
> 
> OpenClaw understands your intent. Claude Code CLI executes it. This harness connects them --
> routing tasks to specialized CLI agents, each with persistent sessions, isolated workspaces,
> and full autonomy. Works with any LLM model as the classifier (GPT, Claude, Gemini).

## Architecture

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

OpenClaw classifies incoming Telegram messages and attaches a `[routing: agent]` tag.
A `message:sent` hook forwards the tagged message to this harness, which dispatches it
to the appropriate CLI agent in the pool.

## Why This Project

| Problem | Our Solution |
|---------|-------------|
| OpenClaw can't run shell commands or edit files directly | CLI agents with full system access do it |
| Non-Claude models can't use MCP tools | Structured output routing bypasses MCP entirely |
| Single CLI session bottleneck | 3 specialized agents work in parallel |
| No task visibility | `.tasks/` board in each workspace, queryable via API |
| One-size-fits-all config | Per-agent `.claude/` workspace with custom rules, hooks, subagents |

## Core Features

- 🔀 **Multi-CLI pool** -- 3 specialized agents (general / code / complex), each a long-running Claude Code CLI process
- 🏗️ **Per-agent workspaces** -- `.cli-workspaces/{name}/` with full `.claude/` customization (CLAUDE.md, settings.json, rules, subagents)
- 🎯 **Structured output routing** -- `[routing: general|code|complex]` tags drive automatic dispatch
- 🦞 **OpenClaw integration** -- HTTP-to-CLI bridge + Telegram via OpenClaw hooks
- ⏰ **Scheduled tasks** -- Cron, interval, and one-shot scheduling through OpenClaw's built-in scheduler
- 💾 **Session persistence** -- Atomic JSON writes with schema validation, token usage tracking per session
- 📝 **Structured logging** -- Configurable log levels (DEBUG / INFO / WARN / ERROR)
- ✅ **138 tests, zero external dependencies** -- Node.js 18+ built-in APIs only
- 🔄 **GitHub Actions CI** -- Automated test runs on push

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

The server starts on `http://127.0.0.1:18795` (localhost only).

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `18795` | HTTP server port |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI binary |
| `DEFAULT_CWD` | `/root` | Default working directory for CLI processes |
| `AUTH_TOKEN` | *(empty)* | When set, all prefixed endpoints require `Authorization: Bearer <token>` |
| `MAX_CONCURRENT` | `3` | Maximum concurrent Claude CLI processes |
| `LOG_LEVEL` | `INFO` | Minimum log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LEAD_TIMEOUT` | `300` | Default CLI send timeout in seconds |
| `BASH_DISABLED` | *(empty)* | Set `true` to disable the `/bash` endpoint (returns 403) |
| `BASH_ALLOWED_COMMANDS` | *(empty)* | Comma-separated whitelist of allowed commands (e.g. `ls,cat,grep`) |

## API Endpoints

All endpoints (except `/health`) are prefixed with `/backend-api/claude-code`.

Example: `POST http://localhost:18795/backend-api/claude-code/cli/send`

### Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server uptime, active sessions, process count (no prefix, no auth) |

### CLI Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/cli/start` | Start a named CLI session (general / code / complex) |
| `POST` | `/cli/send` | Send a message to a named CLI (lazy-starts if not running) |
| `POST` | `/cli/stop` | Stop a named CLI session |
| `GET` | `/cli/list` | List all CLI sessions in the pool |
| `GET` | `/cli/:name/status` | Get status of a specific CLI session |

### Task Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/task/submit` | Submit a task to the lead agent |
| `GET` | `/task/:taskId/status` | Get task status by ID |
| `GET` | `/tasks/list` | List all tasks |
| `POST` | `/task/:taskId/cancel` | Cancel a running task |
| `POST` | `/lead/restart` | Restart the lead agent |
| `GET` | `/lead/status` | Get lead agent status |

### Session Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/session/start` | Create a named session (spawns Claude, stores session ID) |
| `POST` | `/session/send` | Send a message to a named session |
| `POST` | `/session/send-stream` | Send a message with SSE streaming output |
| `GET` | `/session/list` | List all active named sessions |
| `POST` | `/session/stop` | Remove a named session |
| `POST` | `/session/status` | Get session details, token usage, uptime |
| `POST` | `/session/restart` | Restart a failed/stale session |
| `POST` | `/session/history` | Get conversation history with pagination |

### Tools

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/bash` | Execute a shell command (with security controls) |
| `POST` | `/read` | Read a file from disk |
| `POST` | `/call` | Execute Glob, Grep, or Read directly |
| `POST` | `/batch-read` | Batch read files by glob patterns |
| `GET` | `/tools` | List available Claude Code tools |

### Connection

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/connect` | Check connectivity, returns tool count |
| `POST` | `/disconnect` | Signal client disconnect |
| `GET` | `/sessions` | List JSONL session files from disk |
| `POST` | `/resume` | Resume a Claude session by session ID |
| `POST` | `/continue` | Continue the most recent Claude session |

## CLI Agent Workspaces

Each CLI agent (general, code, complex) can have a dedicated workspace at `.cli-workspaces/{name}/`.
When a CLI starts, the harness checks for this directory and uses it as the working directory automatically.

A workspace can contain:

- `CLAUDE.md` -- Agent-specific project instructions
- `.claude/settings.json` -- Local settings and hooks
- `.claude/rules/` -- Additional rule files
- `.claude/agents/` -- Subagent definitions

See [`openclaw/claude_setting_example/README.md`](openclaw/claude_setting_example/README.md) for full examples of all three agent configurations.

## OpenClaw Integration

OpenClaw is the external orchestration layer that connects Telegram users to this harness.

- **Hooks** -- The `message:sent` hook in `openclaw/hooks/cli-router/` intercepts messages tagged with `[routing: agent]` and forwards them to the appropriate CLI endpoint
- **Telegram** -- Users interact via Telegram; OpenClaw classifies messages and tags them for routing
- **Configuration** -- See `openclaw/docker-compose.yml` and `openclaw/openclaw.json.example` for deployment setup
- **Agent roles** -- See `openclaw/AGENTS.md` for agent role definitions
- **Skills** -- See `openclaw/SKILL.md` for skill configuration
- **Bootstrap** -- See `openclaw/BOOTSTRAP.md` for initial setup sequence

## Scheduled Tasks

OpenClaw's built-in cron scheduler supports three scheduling modes:

- **Cron expressions** -- `--cron "0 10 * * *"` for precise timing
- **Fixed intervals** -- `--every "30m"` for periodic checks
- **One-shot** -- `--at "5m"` for delayed execution

Results can be pushed to Telegram. Messages containing `[routing: xxx]` tags are automatically dispatched to the corresponding CLI agent.

See [`openclaw/cron-guide.md`](openclaw/cron-guide.md) for the full configuration guide.

## How It Works (30-second version)

1. You send a message via Telegram
2. OpenClaw's model classifies it: `Processing your request... [routing: code] write unit tests`
3. A `message:sent` hook intercepts the tag
4. The hook calls our harness API (`POST /cli/send`)
5. The harness dispatches to the `code` CLI agent
6. Claude Code CLI executes the task with full file system access
7. Result is sent back to you via Telegram Bot API

**The model only classifies. The CLI does all the work.**

## Project Structure

```
server.js                     -- Entry point (delegates to src/server.js)
src/
  server.js                   -- HTTP server, route dispatch, auth, CORS
  routes/
    cli.js                    -- CLI pool endpoints (/cli/*)
    task.js                   -- Task management endpoints (/task/*, /tasks/*, /lead/*)
    session.js                -- Named session endpoints (/session/*)
    claude.js                 -- Claude CLI endpoints (/connect, /sessions, /resume, etc.)
    tools.js                  -- Direct tool endpoints (/bash, /read, /call, /batch-read)
  lib/
    cli-pool.js               -- Multi-CLI pool (general/code/complex)
    claude-runner.js           -- Claude CLI process spawning, SSE streaming, concurrency
    session-store.js           -- Session persistence (atomic writes, schema validation)
    task-store.js              -- Task state persistence
    helpers.js                 -- JSON response, body parsing, CLI arg builder
    logger.js                  -- Structured logger (LOG_LEVEL controlled)
openclaw/
  docker-compose.yml           -- OpenClaw deployment config
  openclaw.json.example        -- OpenClaw configuration example
  AGENTS.md                    -- Agent role definitions
  SKILL.md                     -- Skill configuration
  BOOTSTRAP.md                 -- Initial setup sequence
  hooks/cli-router/            -- Message routing hook
  mcp/                         -- HTTP-to-CLI bridge config
  claude_setting_example/      -- Example .claude/ configs for all 3 agents
test/
  helpers.test.js              -- Unit tests for helper utilities
  server.test.js               -- Integration tests for HTTP endpoints
  lead-agent.test.js           -- Lead agent / task routing tests
  cli-pool.test.js             -- CLI pool tests
  fake-claude.js               -- Mock Claude CLI for testing
docs/
  openapi.yaml                 -- OpenAPI 3.0 specification
  cron-guide.md                -- Scheduled tasks guide
```

## Testing

```bash
npm test
```

138 tests. Uses the Node.js built-in test runner (`node --test`). A mock Claude CLI (`test/fake-claude.js`) is included so tests run without a real Claude installation.

## License

MIT
