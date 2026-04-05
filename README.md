# Openclaw Catch Claude Code

HTTP-to-CLI bridge for programmatic control of Claude Code sessions.

## Architecture

```
Caller (Bot / API / CLI)
        |
        v
  HTTP Server (server.js)  ---- Bearer token auth (optional)
        |
        v
  spawn claude -p [args]   ---- Claude Code CLI
        |
        v
  Session Store             ---- ~/.claude/session-store.json
  (atomic write + schema validation)
```

## Features

- Multi-turn session management (create, resume, stop, restart)
- SSE streaming output with heartbeat to prevent proxy timeouts
- Session persistence via atomic write-to-temp-then-rename with schema validation
- Token usage tracking (input/output tokens per session)
- Conversation history replay from JSONL files with pagination
- Bearer token authentication (optional, via `AUTH_TOKEN`)
- Structured logging with configurable log level (`LOG_LEVEL`)
- Bash execution security controls (disable switch, command whitelist, hardcoded blacklist)
- Concurrent process limiting (`MAX_CONCURRENT`)
- Per-session request locking (prevents concurrent writes to the same session)
- Zero external dependencies -- Node.js 18+ built-in APIs only

## Quick Start

```bash
git clone https://github.com/samwalter2949348803-stack/Openclaw-catch-Claude-Code.git
cd Openclaw-catch-Claude-Code
node server.js
# or
npm start
```

The server starts on `http://127.0.0.1:18795` by default (localhost only).

### Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `18795` | HTTP server port |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI binary |
| `DEFAULT_CWD` | `/root` | Default working directory for Claude CLI processes |
| `CLAUDE_SESSIONS_DIR` | `~/.claude/projects/<cwd-slug>` | Directory where Claude stores JSONL session files |
| `AUTH_TOKEN` | *(empty)* | When set, all endpoints (except `/health`) require `Authorization: Bearer <token>` |
| `MAX_CONCURRENT` | `3` | Maximum number of concurrent Claude CLI processes |
| `LOG_LEVEL` | `INFO` | Minimum log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `BASH_DISABLED` | *(empty)* | Set to `true` to disable the `/bash` endpoint entirely (returns 403) |
| `BASH_ALLOWED_COMMANDS` | *(empty)* | Comma-separated whitelist of allowed command names (e.g. `ls,cat,grep`) |

## API Endpoints

All endpoints (except `/health`) are prefixed with `/backend-api/claude-code`.

For example: `POST http://localhost:18795/backend-api/claude-code/session/start`

### Health and Connection

| Method | Endpoint | Description | Status |
|---|---|---|---|
| `GET` | `/health` | Server uptime, active sessions, process count (no prefix, no auth) | done |
| `POST` | `/connect` | Check connectivity, returns tool count | done |
| `POST` | `/disconnect` | Signal client disconnect (no-op) | done |
| `GET` | `/tools` | List available Claude Code tools | done |

### Claude CLI Sessions

| Method | Endpoint | Description | Status |
|---|---|---|---|
| `GET` | `/sessions` | List JSONL session files from disk | done |
| `POST` | `/resume` | Resume a Claude session by session ID | done |
| `POST` | `/continue` | Continue the most recent Claude session | done |

### Named Session Management

| Method | Endpoint | Description | Status |
|---|---|---|---|
| `POST` | `/session/start` | Create a named session (spawns Claude, stores session ID) | done |
| `POST` | `/session/send` | Send a message to a named session, wait for response | done |
| `POST` | `/session/send-stream` | Send a message with SSE streaming output | done |
| `GET` | `/session/list` | List all active named sessions | done |
| `POST` | `/session/stop` | Remove a named session | done |
| `POST` | `/session/status` | Get session details, token usage, uptime | done |
| `POST` | `/session/restart` | Restart a failed/stale session | done |
| `POST` | `/session/history` | Get conversation history with pagination | done |
| `POST` | `/session/pause` | Pause a session | stub (501) |
| `POST` | `/session/resume` | Resume a paused session | stub (501) |
| `POST` | `/session/fork` | Fork a session | stub (501) |
| `POST` | `/session/search` | Search session history | stub (501) |

### Direct Tool Execution

| Method | Endpoint | Description | Status |
|---|---|---|---|
| `POST` | `/bash` | Execute a shell command (with security controls) | done |
| `POST` | `/read` | Read a file from disk | done |
| `POST` | `/call` | Execute Glob, Grep, or Read directly | done |
| `POST` | `/batch-read` | Batch read files by glob patterns | done |

## CLI Tool

The `openclaw-claude-code-skill/` subdirectory contains a companion CLI that talks to this server. It provides commands like `session-start`, `session-send`, `session-stop`, etc., suitable for use as an OpenClaw agent skill.

```bash
cd openclaw-claude-code-skill
npm install
npm run build
npm link          # makes `claude-code-skill` available globally

claude-code-skill connect
claude-code-skill session-start myproject -d /path/to/project
claude-code-skill session-send myproject "explain this codebase"
claude-code-skill session-stop myproject
```

See [`openclaw-claude-code-skill/README.md`](openclaw-claude-code-skill/README.md) for full documentation.

## Security

### Authentication

Set the `AUTH_TOKEN` environment variable to require Bearer token authentication on all prefixed endpoints. The `/health` endpoint is always public.

```bash
AUTH_TOKEN=my-secret-token node server.js
```

Clients must include `Authorization: Bearer my-secret-token` in every request.

### Bash Endpoint Controls

The `/bash` endpoint has three layers of protection:

1. **Kill switch** -- Set `BASH_DISABLED=true` to disable it entirely (returns 403).
2. **Hardcoded blacklist** -- Commands matching destructive patterns (`rm -rf /`, `mkfs`, `dd if=/dev`, fork bomb) are always blocked.
3. **Command whitelist** -- Set `BASH_ALLOWED_COMMANDS=ls,cat,grep` to restrict which executables can be invoked. Only the first token (command name) is checked.

### Network Binding

The server binds to `127.0.0.1` only. It is not accessible from external networks unless you explicitly proxy it.

## Project Structure

```
server.js                  -- Entry point (delegates to src/server.js)
src/
  server.js                -- HTTP server, route dispatch, auth, CORS
  routes/
    session.js             -- Named session endpoints (/session/*)
    claude.js              -- Claude CLI endpoints (/connect, /sessions, /resume, etc.)
    tools.js               -- Direct tool endpoints (/bash, /read, /call, /batch-read)
  lib/
    claude-runner.js       -- Claude CLI process spawning, SSE streaming, concurrency
    session-store.js       -- Session persistence (JSON file, atomic writes, schema validation)
    helpers.js             -- JSON response, body parsing, CLI arg builder
    logger.js              -- Structured logger (LOG_LEVEL controlled)
test/
  helpers.test.js          -- Unit tests for helper utilities
  server.test.js           -- Integration tests for HTTP endpoints
  fake-claude.js           -- Mock Claude CLI for testing
docs/
  openapi.yaml             -- OpenAPI 3.0 specification
  development-plan.md      -- Development roadmap
openclaw-claude-code-skill/  -- Companion CLI tool (TypeScript)
examples/                  -- Usage examples
```

## Testing

```bash
npm test
```

Tests use the Node.js built-in test runner (`node --test`). A fake Claude CLI script is included in `test/` to allow testing without a real Claude installation.

## API Documentation

Full OpenAPI 3.0 specification is available at [`docs/openapi.yaml`](docs/openapi.yaml).

## License

MIT
