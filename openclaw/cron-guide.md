# Scheduled Tasks Configuration Guide

OpenClaw has a built-in cron scheduler that supports scheduled, periodic, and one-off tasks, with results optionally pushed to Telegram.

---

## Quick Start

```bash
# Enter the OpenClaw container
docker exec -it openclaw-backend bash

# Add a daily 10 AM reminder (Singapore time)
openclaw cron add \
  --name "morning-reminder" \
  --cron "0 10 * * *" \
  --tz "Asia/Singapore" \
  --session isolated \
  --message "Good morning! A new day has begun." \
  --announce \
  --channel telegram \
  --to "YOUR_TELEGRAM_USER_ID"
```

## Three Scheduling Types

| Type | Parameter | Example | Use Case |
|------|-----------|---------|----------|
| **One-off** | `--at` | `--at "5m"` or `--at "2026-04-06T09:00:00"` | Countdown reminders |
| **Fixed interval** | `--every` | `--every "30m"` | Periodic health checks |
| **Cron expression** | `--cron` | `--cron "0 10 * * *"` | Precise scheduling |

## Cron Expression Cheat Sheet

```
┌───── Minute (0-59)
│ ┌───── Hour (0-23)
│ │ ┌───── Day of month (1-31)
│ │ │ ┌───── Month (1-12)
│ │ │ │ ┌───── Day of week (0-6, 0=Sunday)
│ │ │ │ │
* * * * *
```

| Expression | Meaning |
|------------|---------|
| `0 10 * * *` | Every day at 10:00 |
| `0 9 * * 1-5` | Weekdays at 9:00 |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 * * 0` | Every Sunday at 0:00 |
| `0 9 1 * *` | 1st of every month at 9:00 |

## Common Parameters

| Parameter | Description | Required |
|-----------|-------------|----------|
| `--name` | Task name | Yes |
| `--cron` / `--at` / `--every` | Scheduling method (choose one) | Yes |
| `--message` | Prompt sent to the agent | Yes |
| `--tz` | Time zone (IANA format, e.g. `Asia/Shanghai`) | No, defaults to UTC |
| `--session isolated` | Isolated session per run (recommended) | No |
| `--announce` | Send results to a specified channel | No |
| `--channel telegram` | Output channel | Used with --announce |
| `--to` | Telegram user/group ID | Used with --channel |

## Practical Examples

### Daily Rest Reminder
```bash
openclaw cron add \
  --name "rest-reminder" \
  --cron "0 10 * * *" \
  --tz "Asia/Singapore" \
  --session isolated \
  --message "Remind the user to take a break and maintain a healthy routine." \
  --announce --channel telegram --to "YOUR_ID"
```

### System Health Check Every 30 Minutes (via CLI)
```bash
openclaw cron add \
  --name "system-check" \
  --every "30m" \
  --session isolated \
  --message "Processing your request... [routing: general] Check system status and report anomalies" \
  --announce --channel telegram --to "YOUR_ID"
```

When the message contains a `[routing: xxx]` tag, the cli-router hook automatically intercepts it and hands execution to the CLI.

### Weekday Code Audit
```bash
openclaw cron add \
  --name "code-audit" \
  --cron "0 9 * * 1-5" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "Processing your request... [routing: complex] Analyze git commits from the last 24 hours and summarize changes" \
  --announce --channel telegram --to "YOUR_ID"
```

### One-off Reminder in 2 Minutes
```bash
openclaw cron add \
  --name "quick-test" \
  --at "2m" \
  --session isolated \
  --message "Scheduled test: task triggered successfully!" \
  --announce --channel telegram --to "YOUR_ID"
```

## Management Commands

```bash
# List all scheduled tasks
openclaw cron list

# View details of a specific task
openclaw cron info <job-id>

# Pause a task
openclaw cron disable <job-id>

# Resume a task
openclaw cron enable <job-id>

# Delete a task
openclaw cron remove <job-id>

# Trigger a task immediately (without waiting for the next schedule)
openclaw cron trigger <job-id>
```

## Getting Your Telegram ID

Send a message to `@userinfobot` on Telegram and it will reply with your user ID.

## Notes

- Tasks are persisted in `~/.openclaw/cron/jobs.json` and survive restarts
- `--session isolated` creates a new session each run, preventing context pollution
- One-off tasks created with `--at` are automatically deleted after execution
- Use IANA format for time zones: `Asia/Shanghai`, `Asia/Singapore`, `America/New_York`, etc.
- If a scheduled task's message contains `[routing: xxx]`, it will automatically be routed to CLI execution
