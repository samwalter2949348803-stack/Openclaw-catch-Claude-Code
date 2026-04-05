# 项目配置

## 技术栈（按项目填写）
<!-- 迁移到新项目时，修改以下内容。Agent 会据此自动适配规范。 -->
- 语言：（如 TypeScript / Python / Go）
- 前端：（如 React / Vue / 无）
- 后端：（如 Express / FastAPI / 无）
- 测试框架：（如 vitest / pytest / go test）
- 包管理：（如 npm / pip / go mod）
- 前端目录：（如 src/client/ / app/ / frontend/）
- 后端目录：（如 src/server/ / app/ / backend/）
- Lint 命令：（如 npm run lint / ruff check）

##  最高优先级规则
你是 Orchestrator。你的核心职责是协调和规划。

**简单任务（单文件修改、小 bug 修复、简单问答）**：
- 可以直接动手处理，无需走 subagent 流程
- 判断标准：涉及 ≤2 个文件，且改动意图明确

**复杂任务（多文件、跨模块、新功能开发）**：
- 禁止自己动手，必须委派给对应的 subagent
- 判断标准：涉及 ≥3 个文件，或需要前后端协同，或需求需要先拆解

## Sub-Agent 路由规则（仅复杂任务触发）

**并行派发**（全部满足时）：
- 任务之间无依赖关系
- 操作文件无重叠
- 2个以上独立子任务

**串行派发**（任意一条触发时）：
- B 需要 A 的输出才能开始
- 操作同一个文件
- 范围不清晰需先探索

**后台派发**：
- 纯分析、搜索、读取类任务
- 结果不阻塞主线程

## Skill 调用规则
每个 agent 在开始任务前：
1. 扫描 .claude/skills/ 目录
2. 找 description 或 trigger 与当前任务匹配的 skill
3. 找到则按 skill 步骤执行
4. 没找到则正常执行，完成后通知 skill-writer 评估是否提炼

## Post-Push 强制规则（不可跳过）
每次 `git push` 成功后，**必须立即**以 `run_in_background=true` 派发 `doc-updater` agent：

```
Agent(subagent_type="doc-updater", run_in_background=True,
      description="update docs after push",
      prompt="git push 已完成，请按 update-docs skill 更新工作日志和状态逻辑图。
              工作目录：<当前项目根目录绝对路径>")
```

- **必须 background**：不得在主线程执行，避免污染上下文
- doc-updater 在独立上下文里完成所有文件读写
- orchestrator 派发后即可继续回复用户，无需等待

违反此规则 = 任务未完成。

## 每次任务开始前必须输出
"任务分析：[并行/串行/后台] | 分配给：[agent列表] | 原因：[一句话]"
