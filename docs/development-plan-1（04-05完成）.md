# Openclaw-catch-Claude-Code 开发计划

> 目标：让 OpenClaw 能够**可靠、安全、可观测地**控制 Claude Code CLI 会话
> 
> 创建日期：2026-04-05

---

## 现状诊断

| 问题 | 严重度 | 说明 |
|------|--------|------|
| MCP 层全是死代码 | 高 | client.ts / actions.ts / types.ts / persist.ts 从未被调用 |
| 5 个 stub 端点返回假数据 | 高 | history / fork / pause / resume / search 给调用方错觉 |
| server.js 31KB 单文件 | 中 | 难维护、难测试、难 review |
| 错误静默吞掉 | 高 | JSON parse 失败不报、流式出错不清理 |
| Token 统计硬编码为 0 | 中 | 调用方无法追踪用量 |
| /bash 端点无沙箱 | 高 | 任意命令执行，安全风险 |
| 会话持久化无保护 | 中 | 无文件锁、无 schema 校验、并发写可能损坏 |

---

## 核心约束

1. **不破坏现有 API** — OpenClaw 正在使用，重构必须保持端点签名兼容
2. **零外部依赖** — server 端继续不引入 npm 包
3. **每阶段可独立交付** — 完成一个阶段就能立即受益

---

## Phase 0 — 清理（让代码诚实）

> 删掉假的，留下真的。

| 任务 | 负责 | 依赖 | 内容 |
|------|------|------|------|
| P0-1 | backend-dev | 无 | 删除/501化 5 个 stub 端点（history, fork, pause, resume, search） |
| P0-2 | skill-dev | 无 | CLI 子模块对应命令标注 `[Not Implemented]`，调用时打印提示 |
| P0-3 | backend-dev | P0-1 | README 移除 MCP 声明，package.json 删 "mcp" keyword，端点文档标注实际状态 |

```
执行顺序：
  并行 → P0-1, P0-2
  串行 → P0-3
```

---

## Phase 1 — 稳固核心（让现有功能不出错）

> 拆分 → 加固 → 可观测。

| 任务 | 负责 | 依赖 | 内容 |
|------|------|------|------|
| P1-1 | backend-dev | 无 | server.js 拆分为模块化结构（见下方架构） |
| P1-2 | backend-dev | P1-1 | 错误处理加固：不吞错误、流式清理、body 大小限制 |
| P1-3 | backend-dev | P1-1 | 会话持久化加固：write-temp-rename、schema 校验 |
| P1-4 | backend-dev | P1-1 | 结构化日志：统一 log 函数，支持 LOG_LEVEL 环境变量 |

### P1-1 拆分目标结构

```
server.js                    ← 薄入口，import src/server.js
src/
  server.js                  ← HTTP 服务器、路由分发、CORS、Auth
  routes/
    session.js               ← /session/* 所有端点
    tools.js                 ← /call, /bash, /read, /batch-read
    claude.js                ← /resume, /continue, /sessions
  lib/
    claude-runner.js          ← runClaude(), streamClaude()
    session-store.js          ← sessions Map、持久化、锁机制
    logger.js                 ← 结构化日志
    helpers.js                ← json(), parseBody(), buildClaudeArgs()
```

```
执行顺序：
  串行 → P1-1（关键路径，后续全部依赖）
  并行 → P1-2, P1-3, P1-4
```

---

## Phase 2 — 补全能力（做到真正好用）

> 从"能用"到"好用"。

| 任务 | 负责 | 依赖 | 内容 |
|------|------|------|------|
| P2-1 | backend-dev | P1-1 | Token 统计真实化：从 CLI 输出解析 usage，session 累加 |
| P2-2 | backend-dev | P1-1 | /bash 端点安全化：命令白名单 + BASH_DISABLED 开关 + 执行日志 |
| P2-3 | backend-dev | P1-1 | 实现 /session/history：读取 Claude JSONL 会话文件，支持分页 |
| P2-4 | backend-dev | P1-2 | SSE 流式增强：heartbeat 防超时、error 事件类型、断连清理 |
| P2-5 | skill-dev | P2-1, P2-3 | CLI 子模块同步：status 展示真实 token、history 连接真实端点 |

```
执行顺序：
  并行 → P2-1, P2-2, P2-3, P2-4
  串行 → P2-5（等 P2-1 和 P2-3 接口稳定）
```

---

## Phase 3 — 开发体验（可维护、可贡献）

> 让别人也能参与。

| 任务 | 负责 | 依赖 | 内容 |
|------|------|------|------|
| P3-1 | test-writer | Phase 2 | 集成测试：node:test，fake claude 脚本 mock CLI |
| P3-2 | backend-dev | Phase 2 | OpenAPI spec：docs/openapi.yaml，所有真实端点 |
| P3-3 | backend-dev | P3-1, P3-2 | README 终版重写：真实架构图 + 端点列表 + 安全配置指南 |
| P3-4 | backend-dev | P3-1 | GitHub Actions CI：push/PR 自动跑 npm test |

```
执行顺序：
  并行 → P3-1, P3-2
  串行 → P3-3
  并行 → P3-4
```

---

## 全局执行流水线

```
Phase 0（清理）
  ┌─ P0-1 (backend-dev) ─┐
  └─ P0-2 (skill-dev) ───┘→ P0-3 (backend-dev)
                                    │
Phase 1（稳固核心）                  ▼
  P1-1 (backend-dev) ─────┬─ P1-2 (backend-dev)
                           ├─ P1-3 (backend-dev)
                           └─ P1-4 (backend-dev)
                                    │
Phase 2（补全能力）                  ▼
  ┌─ P2-1 ─┐
  ├─ P2-2 ─┤
  ├─ P2-3 ─┤ (all backend-dev) ──→ P2-5 (skill-dev)
  └─ P2-4 ─┘
                                    │
Phase 3（开发体验）                  ▼
  ┌─ P3-1 (test-writer) ─┐
  └─ P3-2 (backend-dev) ─┘→ P3-3 (backend-dev) → P3-4 (backend-dev)
```

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| P1-1 拆分引入回归 | 所有端点可能行为变化 | 拆分前先写冒烟测试（健康检查 + session CRUD） |
| Claude CLI 不返回 usage 字段 | P2-1 token 统计无数据 | 先验证实际输出格式，缺失时返回 null 而非 0 |
| OpenClaw 依赖 stub 端点的 ok:true | P0-1 改 501 可能影响 bot | 先确认 OpenClaw 是否调用这些端点，必要时保留 ok:true + stub:true 标记 |
| /bash 白名单过严 | 限制 OpenClaw 能力 | 默认不开白名单（向后兼容），只在安全敏感部署时启用 |

---

## MCP 层决策

当前 `openclaw-claude-code-skill/src/mcp/` 下的代码（client.ts, actions.ts, types.ts, utils.ts）**全部未使用**。

**决策：Phase 0 暂不删除，挂起观察。**

理由：
- MCP 是 Claude Code 的发展方向，未来可能需要真正接入
- 当前不删除但在 README 中明确标注为 "experimental / not integrated"
- 如果 Phase 2 完成后仍未找到 MCP 接入场景，Phase 3 中清理

---

*此计划由 Orchestrator + Planner agent 协同生成，随项目进展持续更新。*
