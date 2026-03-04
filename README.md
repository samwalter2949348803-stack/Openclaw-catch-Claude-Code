# Openclaw-catch-Claude-Code

Backend API server for [openclaw-claude-code-skill](https://github.com/Enderfga/openclaw-claude-code-skill).

Bridges the `claude-code-skill` CLI to the Claude Code CLI, enabling OpenClaw agents (e.g. via Telegram) to control Claude Code programmatically.

## Architecture

```
Telegram → OpenClaw/Qwen → claude-code-skill CLI → this server (:18795) → claude CLI
```

## Quick Start

```bash
git clone https://github.com/samwalter2949348803-stack/Openclaw-catch-Claude-Code.git
cd Openclaw-catch-Claude-Code

# Start the server
node server.js

# In another terminal, verify it works
claude-code-skill connect
claude-code-skill sessions
claude-code-skill session-start myproject -d /root
claude-code-skill session-send myproject "say hello"
claude-code-skill session-stop myproject
```

## Requirements

- Node.js 18+ (zero external dependencies)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [claude-code-skill](https://github.com/Enderfga/openclaw-claude-code-skill) CLI installed

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `18795` | Port to listen on |
| `CLAUDE_BIN` | `claude` | Path to Claude Code CLI binary |
| `DEFAULT_CWD` | `/root` | Default working directory for Claude |
| `CLAUDE_SESSIONS_DIR` | `~/.claude/projects/-root` | Where Claude session files are stored |
| `AUTH_TOKEN` | *(empty)* | Set to require `Bearer` token auth on all endpoints |

## Auto-Restart with systemd

```bash
# Copy the service file
sudo cp claude-code-backend.service /etc/systemd/system/

# Edit paths if needed
sudo nano /etc/systemd/system/claude-code-backend.service

# Enable and start
sudo systemctl enable claude-code-backend
sudo systemctl start claude-code-backend

# Check status
sudo systemctl status claude-code-backend
```

## Supported Endpoints

All endpoints are prefixed with `/backend-api/claude-code`.

### Health Check (no prefix, no auth)
- `GET /health` — Server uptime, active session count

### Connection
- `POST /connect` — Check connectivity
- `POST /disconnect` — Disconnect (no-op)
- `GET /tools` — List available Claude Code tools

### Session History
- `GET /sessions` — List Claude Code session files from disk
- `POST /resume` — Resume a specific session by ID
- `POST /continue` — Continue the most recent session

### Persistent Named Sessions
- `POST /session/start` — Create a named session (spawns Claude, stores session ID)
- `POST /session/send` — Send a message to a named session
- `POST /session/send-stream` — Send with SSE streaming output
- `GET /session/list` — List active in-memory sessions
- `POST /session/stop` — Remove a session
- `POST /session/status` — Get session details and stats
- `POST /session/restart` — Restart a failed session

### Direct Operations
- `POST /bash` — Execute a shell command directly
- `POST /read` — Read a file from disk

## Security

- The server binds to `127.0.0.1` only (localhost) — not accessible from the internet
- Set `AUTH_TOKEN` env var to require Bearer token authentication
- The `/bash` endpoint executes arbitrary commands — use auth in shared environments

## How It Works

1. Single-file Node.js HTTP server with **zero dependencies**
2. Spawns `claude -p` as child processes, unsetting `CLAUDECODE` env var to avoid nesting errors
3. Named sessions map a friendly name to a Claude session ID for multi-turn conversations
4. Streaming uses Claude's `--output-format stream-json` and forwards events as SSE

## License

MIT
