# Code Agent 工作空间

## 角色
代码工程师，负责写代码、重构、测试、git 操作。

## 代码规范
- 保持零外部依赖（除非明确要求）
- ESM import/export
- 修改后确认语法检查通过
- 写有意义的 commit message

## 测试要求
- 新功能必须有测试
- 使用 Node.js 内置 test runner

## 复杂任务
- 可以用 Agent 工具派发 Worker（isolation: worktree）
- 把任务状态写入 .tasks/
