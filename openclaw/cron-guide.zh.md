# 定时任务配置指南

OpenClaw 内置 cron 调度器，支持定时、周期和一次性任务，结果可推送至 Telegram。

---

## 快速开始

```bash
# 进入 OpenClaw 容器
docker exec -it openclaw-backend bash

# 添加每天上午 10 点提醒（新加坡时间）
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

## 三种调度类型

| 类型 | 参数 | 示例 | 适用场景 |
|------|------|------|----------|
| **一次性** | `--at` | `--at "5m"` 或 `--at "2026-04-06T09:00:00"` | 倒计时提醒 |
| **固定间隔** | `--every` | `--every "30m"` | 周期性健康检查 |
| **Cron 表达式** | `--cron` | `--cron "0 10 * * *"` | 精确调度 |

## Cron 表达式速查

```
┌───── 分钟 (0-59)
│ ┌───── 小时 (0-23)
│ │ ┌───── 日 (1-31)
│ │ │ ┌───── 月 (1-12)
│ │ │ │ ┌───── 星期 (0-6, 0=周日)
│ │ │ │ │
* * * * *
```

| 表达式 | 含义 |
|--------|------|
| `0 10 * * *` | 每天 10:00 |
| `0 9 * * 1-5` | 工作日 9:00 |
| `*/30 * * * *` | 每 30 分钟 |
| `0 0 * * 0` | 每周日 0:00 |
| `0 9 1 * *` | 每月 1 日 9:00 |

## 常用参数

| 参数 | 说明 | 是否必填 |
|------|------|----------|
| `--name` | 任务名称 | 是 |
| `--cron` / `--at` / `--every` | 调度方式（三选一） | 是 |
| `--message` | 发送给 agent 的 prompt | 是 |
| `--tz` | 时区（IANA 格式，如 `Asia/Shanghai`） | 否，默认 UTC |
| `--session isolated` | 每次运行使用独立会话（推荐） | 否 |
| `--announce` | 将结果推送到指定渠道 | 否 |
| `--channel telegram` | 输出渠道 | 配合 --announce 使用 |
| `--to` | Telegram 用户/群组 ID | 配合 --channel 使用 |

## 实用示例

### 每日休息提醒
```bash
openclaw cron add \
  --name "rest-reminder" \
  --cron "0 10 * * *" \
  --tz "Asia/Singapore" \
  --session isolated \
  --message "Remind the user to take a break and maintain a healthy routine." \
  --announce --channel telegram --to "YOUR_ID"
```

### 每 30 分钟系统健康检查（通过 CLI 执行）
```bash
openclaw cron add \
  --name "system-check" \
  --every "30m" \
  --session isolated \
  --message "Processing your request... [routing: general] Check system status and report anomalies" \
  --announce --channel telegram --to "YOUR_ID"
```

当 message 中包含 `[routing: xxx]` 标签时，cli-router hook 会自动拦截并交由 CLI 执行。

### 工作日代码审计
```bash
openclaw cron add \
  --name "code-audit" \
  --cron "0 9 * * 1-5" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "Processing your request... [routing: complex] Analyze git commits from the last 24 hours and summarize changes" \
  --announce --channel telegram --to "YOUR_ID"
```

### 2 分钟后一次性提醒
```bash
openclaw cron add \
  --name "quick-test" \
  --at "2m" \
  --session isolated \
  --message "Scheduled test: task triggered successfully!" \
  --announce --channel telegram --to "YOUR_ID"
```

## 管理命令

```bash
# 查看所有定时任务
openclaw cron list

# 查看某个任务详情
openclaw cron info <job-id>

# 暂停任务
openclaw cron disable <job-id>

# 恢复任务
openclaw cron enable <job-id>

# 删除任务
openclaw cron remove <job-id>

# 立即触发任务（不等待下次调度）
openclaw cron trigger <job-id>
```

## 获取 Telegram ID

在 Telegram 上给 `@userinfobot` 发一条消息，它会回复你的用户 ID。

## 注意事项

- 任务持久化在 `~/.openclaw/cron/jobs.json`，重启后不丢失
- `--session isolated` 每次运行创建新会话，避免上下文污染
- 使用 `--at` 创建的一次性任务执行后自动删除
- 时区使用 IANA 格式：`Asia/Shanghai`、`Asia/Singapore`、`America/New_York` 等
- 定时任务的 message 中如果包含 `[routing: xxx]`，会自动路由到 CLI 执行
