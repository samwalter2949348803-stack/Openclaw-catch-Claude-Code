---
name: implement
description: 拆解需求并并行实现，不含测试和审查
---

执行实现流程：

1. 使用 planner agent 拆解任务，生成带依赖的任务列表
2. 按任务列表并行派发给对应 agent（backend-dev、frontend-dev）
3. 所有 agent 完成后，汇总修改的文件列表和关键决策
