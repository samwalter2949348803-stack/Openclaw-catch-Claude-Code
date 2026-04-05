---
name: ship
description: 完整交付流程：规划 → 并行实现 → 测试 → 审查 → commit
---

执行完整交付流程：

1. 使用 planner agent 拆解任务，生成带依赖的任务列表
2. 按任务列表并行派发给对应 agent（backend-dev、frontend-dev）
3. 实现完成后，并行触发 test-writer agent 补充测试
4. 所有实现完成后，触发 code-reviewer agent 做全面审查
5. reviewer 通过后，自动执行：
   - git add .
   - git commit -m "[自动生成的 commit message]"
6. 向用户汇总：完成了什么、修改了哪些文件、审查结论
7. 所有任务完成后，使用 skill-writer agent：
   "本次任务遇到了哪些非常规问题？
    解决方案是否值得提炼为 skill？
    如果是，写入 .claude/skills/ 并更新 index.md"
