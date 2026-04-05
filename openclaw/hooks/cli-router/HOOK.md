---
name: cli-router
description: Intercept outbound messages with [routing:] tags, execute tasks via Claude Code CLI agents, and send results back
events:
  - message:sent
---

# CLI Router Hook

Watches for outbound messages containing `[routing: general|code|complex]` tags.
When detected, extracts the agent name and task, calls the Claude Code CLI harness
via HTTP, and sends the result as a follow-up message.
