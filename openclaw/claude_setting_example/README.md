# CLI Agent 示例配置

本目录包含三个 CLI Agent（general / code / complex）的完整示例工作空间配置。

## 目录结构

```
claude_setting_example/
  CLAUDE.md              -- Orchestrator 层级的根配置（已有）
  general/
    CLAUDE.md            -- General Agent 的项目指令
    .claude/
      settings.json      -- 最小化配置
  code/
    CLAUDE.md            -- Code Agent 的项目指令
    .claude/
      settings.json      -- 包含安全 hook（拦截危险命令）
      rules/
        code-standards.md -- 代码标准规则
      agents/
        code-reviewer.md  -- 代码审查 subagent 定义
  complex/
    CLAUDE.md            -- Complex Agent 的项目指令
    .claude/
      settings.json      -- 最小化配置
```

## 使用方法

### 1. 准备工作空间

将示例配置复制到你的 CLI Agent 工作目录：

```bash
# 假设你的项目根目录在 /root/my-project
# 创建 .cli-workspaces 目录（运行时目录）
mkdir -p /root/my-project/.cli-workspaces/general
mkdir -p /root/my-project/.cli-workspaces/code
mkdir -p /root/my-project/.cli-workspaces/complex

# 复制示例配置到各 agent 的工作空间
cp -r general/* /root/my-project/.cli-workspaces/general/
cp -r general/.claude /root/my-project/.cli-workspaces/general/

cp -r code/* /root/my-project/.cli-workspaces/code/
cp -r code/.claude /root/my-project/.cli-workspaces/code/

cp -r complex/* /root/my-project/.cli-workspaces/complex/
cp -r complex/.claude /root/my-project/.cli-workspaces/complex/
```

### 2. 自定义配置

- 编辑每个 agent 的 `CLAUDE.md`，根据你的项目调整角色描述和规则
- 编辑 `.claude/settings.json`，添加项目特定的 hook
- 在 `.claude/rules/` 下添加更多规则文件
- 在 `.claude/agents/` 下定义更多 subagent

### 3. 启动 Agent

通过 `/cli/start` 接口启动 agent 时，如果 `.cli-workspaces/{name}/` 目录存在，
系统会自动使用该目录作为 cwd，无需手动指定：

```bash
# 自动使用 .cli-workspaces/code/ 作为 cwd
curl -X POST http://localhost:3000/cli/start \
  -H "Content-Type: application/json" \
  -d '{"name": "code"}'

# 也可以手动指定 cwd 覆盖默认值
curl -X POST http://localhost:3000/cli/start \
  -H "Content-Type: application/json" \
  -d '{"name": "code", "cwd": "/custom/path"}'
```

## 配置说明

### CLAUDE.md

Claude Code 启动时自动读取的项目指令文件。定义 agent 的角色、规则和行为约束。

### .claude/settings.json

Claude Code 的本地设置文件，支持 hooks 配置。示例中 code agent 配置了 `PreToolUse` hook，
会在执行 Bash 命令前检查是否包含危险操作（如 `rm -rf`、`git push --force`）。

### .claude/rules/

额外的规则文件目录，Claude Code 会自动加载目录下所有 `.md` 文件作为补充规则。

### .claude/agents/

Subagent 定义目录。每个 `.md` 文件定义一个可派发的 subagent，包含名称、描述、
可用工具和行为指令。
