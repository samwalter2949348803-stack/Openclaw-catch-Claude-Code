# 定时任务配置指南

OpenClaw 内置 cron 调度器，支持定时、周期、一次性任务，结果可推送到 Telegram。

---

## 快速开始

```bash
# 进入 OpenClaw 容器
docker exec -it openclaw-backend bash

# 添加一个每天早上 10 点的提醒（新加坡时间）
openclaw cron add \
  --name "morning-reminder" \
  --cron "0 10 * * *" \
  --tz "Asia/Singapore" \
  --session isolated \
  --message "早上好！新的一天开始了。" \
  --announce \
  --channel telegram \
  --to "YOUR_TELEGRAM_USER_ID"
```

## 三种调度类型

| 类型 | 参数 | 示例 | 用途 |
|------|------|------|------|
| **一次性** | `--at` | `--at "5m"` 或 `--at "2026-04-06T09:00:00"` | 倒计时提醒 |
| **固定间隔** | `--every` | `--every "30m"` | 周期巡检 |
| **Cron 表达式** | `--cron` | `--cron "0 10 * * *"` | 精确定时 |

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
| `0 9 1 * *` | 每月 1 号 9:00 |

## 常用参数

| 参数 | 说明 | 必填 |
|------|------|------|
| `--name` | 任务名称 | 是 |
| `--cron` / `--at` / `--every` | 调度方式（三选一） | 是 |
| `--message` | 发给 agent 的 prompt | 是 |
| `--tz` | 时区（IANA 格式，如 `Asia/Shanghai`） | 否，默认 UTC |
| `--session isolated` | 每次独立会话（推荐） | 否 |
| `--announce` | 将结果发送到指定频道 | 否 |
| `--channel telegram` | 输出渠道 | 配合 --announce |
| `--to` | Telegram 用户/群组 ID | 配合 --channel |

## 实用示例

### 每天早上提醒休息
```bash
openclaw cron add \
  --name "rest-reminder" \
  --cron "0 10 * * *" \
  --tz "Asia/Singapore" \
  --session isolated \
  --message "提醒用户注意休息，保持良好作息。" \
  --announce --channel telegram --to "YOUR_ID"
```

### 每 30 分钟系统巡检（走 CLI）
```bash
openclaw cron add \
  --name "system-check" \
  --every "30m" \
  --session isolated \
  --message "正在为你处理... [routing: general] 检查系统状态，报告异常" \
  --announce --channel telegram --to "YOUR_ID"
```

message 中包含 `[routing: xxx]` 标记时，cli-router hook 会自动拦截并交给 CLI 执行。

### 工作日代码审计
```bash
openclaw cron add \
  --name "code-audit" \
  --cron "0 9 * * 1-5" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "正在为你处理... [routing: complex] 分析最近 24 小时的 git commit，总结变更" \
  --announce --channel telegram --to "YOUR_ID"
```

### 2 分钟后的一次性提醒
```bash
openclaw cron add \
  --name "quick-test" \
  --at "2m" \
  --session isolated \
  --message "定时测试：任务触发成功！" \
  --announce --channel telegram --to "YOUR_ID"
```

## 管理命令

```bash
# 列出所有定时任务
openclaw cron list

# 查看某个任务详情
openclaw cron info <job-id>

# 暂停任务
openclaw cron disable <job-id>

# 恢复任务
openclaw cron enable <job-id>

# 删除任务
openclaw cron remove <job-id>

# 立即触发一次（不等调度时间）
openclaw cron trigger <job-id>
```

## 获取你的 Telegram ID

在 Telegram 中给 `@userinfobot` 发消息，它会回复你的 user ID。

## 注意事项

- 任务持久化在 `~/.openclaw/cron/jobs.json`，重启不丢失
- `--session isolated` 每次创建新会话，避免上下文污染
- `--at` 类型的一次性任务执行后自动删除
- 时区用 IANA 格式：`Asia/Shanghai`、`Asia/Singapore`、`America/New_York` 等
- 定时任务的 message 如果包含 `[routing: xxx]`，会自动走 CLI 执行
