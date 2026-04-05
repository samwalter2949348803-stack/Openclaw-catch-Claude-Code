# OpenClaw Skill 路由调优记录

> 目标：让 OpenClaw 在需要文件访问、代码、命令执行等场景时，自动使用我们的 CLI agents（通过 MCP cli_send 工具），而非自己尝试执行。

---

## 问题

OpenClaw 有自己的内置工具（exec、read 等），遇到需要文件或命令的任务时会优先用自己的工具，而非我们的 MCP 工具。结果：

1. exec 工具被 Telegram 的审批机制拦截 → 任务失败
2. 失败后不会自动 fallback 到 cli_send → 直接告诉用户"我做不了"
3. 我们的 skill 被当作"备选"而非首选

## 尝试过的方案

### 1. AGENTS.md 系统指令 — 效果有限

```markdown
# AGENTS.md
When you get blocked by exec approval → use cli_send as fallback.
```

**结果**：模型看到了指令，但不是强制规则。GPT-5.4-mini 不会主动关联"被拦了"和"该用 cli_send"。

**结论**：软提示对小模型效果差。

### 2. SKILL.md 加强 — 效果有限

从 v1 到 v5.1 迭代了 5 个版本：

| 版本 | 策略 | 效果 |
|------|------|------|
| v1 | "代码任务用 submit_task" | 模型不认 |
| v2 | 扩大范围到复杂任务 | 仍不主动调用 |
| v3 | 多 CLI 路由规则 | slash 命令可用，自动不行 |
| v4 | "ALL tasks MUST be routed" | OpenClaw 拒绝——太霸道 |
| v5 | 合作式——"当内置工具不够时用" | 方向对了，但 fallback 不触发 |
| v5.1 | 加 requires.config 声明 MCP 依赖 | 正确加载，但路由仍不可靠 |

**结论**：SKILL.md 影响的是模型"可以参考"的指令，不是强制路由。

### 3. Tool Description 加强 — 方向正确

在 MCP bridge 的 cli_send 工具描述中加入：
```
"Also use this as FALLBACK when your built-in tools get blocked by exec approval or permission errors."
```

**结论**：方向对，但模型能力有限时仍然不会关联。

### 4. 禁用竞争 skill — 必要但不够

```json
"skills": { "entries": { "coding-agent": { "enabled": false } } }
```

禁用了 OpenClaw 内置的 coding-agent skill，防止它抢代码任务。

**结论**：消除了竞争，但 OpenClaw 还是会用自己的 exec 工具。

### 5. 禁用 exec 工具 — 最有效 ✅

```json
"tools": { "deny": ["exec"] }
```

直接禁用 OpenClaw 的 exec 工具（shell 命令执行能力）。

**结论**：**硬限制 > 软提示**。OpenClaw 自己跑不了命令了，遇到需要命令执行的任务只能走 cli_send。

---

## 最终配置组合

五层防线，缺一不可：

```
1. tools.deny: ["exec"]           ← 硬限制：禁用自己的 exec
2. skills.coding-agent: disabled  ← 消除竞争 skill
3. AGENTS.md                      ← 系统级指令：引导用 cli_send
4. SKILL.md v5.1                  ← 场景化触发 + MCP 依赖声明
5. Tool description               ← cli_send 描述写明适用场景
```

### 每层的作用

| 层 | 类型 | 作用 | 可靠性 |
|----|------|------|--------|
| exec deny | 硬配置 | 从根源禁止自己跑命令 | 100% |
| coding-agent disabled | 硬配置 | 不让内置 skill 抢任务 | 100% |
| AGENTS.md | 软提示 | 引导模型优先用 cli_send | 中等 |
| SKILL.md | 软提示 | 精准描述触发场景 | 中等 |
| Tool description | 软提示 | 工具选择时的直接参考 | 中等 |

## 核心教训

> **不要靠 prompt 说服模型，要靠配置限制模型的选择空间。**
>
> 当你禁用了 exec 工具，模型面对"需要跑命令"的任务时，工具列表里只剩 cli_send 可选。
> 它不需要"理解"你的指令，它只是没有其他选择了。

---

## 文件清单

| 文件 | 位置 | 作用 |
|------|------|------|
| openclaw.json | Docker volume | tools.deny + skills.entries + mcp.servers |
| AGENTS.md | Docker volume | 系统级路由指令 |
| SKILL.md | Docker volume skills/ | 场景化触发规则 |
| harness_bridge.py | openclaw/mcp/ | MCP 工具定义 + description |
