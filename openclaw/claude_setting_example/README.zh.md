# CLI Agent 示例配置

本目录包含三个 CLI Agent（general / code / complex）的完整工作区示例配置。

## 目录结构

```
claude_setting_example/
  general/
    CLAUDE.md            -- General Agent 的项目指令
    .claude/
      settings.json      -- 最小化配置
  code/
    CLAUDE.md            -- Code Agent 的项目指令
    .claude/
      settings.json      -- 包含安全 hook（拦截危险命令）
      rules/
        code-standards.md -- 代码规范规则
      agents/
        code-reviewer.md  -- 代码审查 subagent 定义
  complex/
    CLAUDE.md            -- Complex Agent 的项目指令
    .claude/
      settings.json      -- 最小化配置
```

## 使用方法

### 1. 准备工作区

将示例配置复制到你的 CLI Agent 工作目录：

```bash
# 假设项目根目录在 /root/my-project
# 创建 .cli-workspaces 目录（运行时目录）
mkdir -p /root/my-project/.cli-workspaces/general
mkdir -p /root/my-project/.cli-workspaces/code
mkdir -p /root/my-project/.cli-workspaces/complex

# 将示例配置复制到各 agent 的工作区
cp -r general/* /root/my-project/.cli-workspaces/general/
cp -r general/.claude /root/my-project/.cli-workspaces/general/

cp -r code/* /root/my-project/.cli-workspaces/code/
cp -r code/.claude /root/my-project/.cli-workspaces/code/

cp -r complex/* /root/my-project/.cli-workspaces/complex/
cp -r complex/.claude /root/my-project/.cli-workspaces/complex/
```

### 2. 自定义配置

- 编辑各 agent 的 `CLAUDE.md`，根据项目需要调整角色描述和规则
- 编辑 `.claude/settings.json`，添加项目特定的 hook
- 在 `.claude/rules/` 下添加更多规则文件
- 在 `.claude/agents/` 下定义更多 subagent

### 3. 启动 Agent

通过 `/cli/start` 端点启动 agent 时，如果 `.cli-workspaces/{name}/` 目录存在，系统会自动将其作为 cwd，无需手动指定：

```bash
# 自动使用 .cli-workspaces/code/ 作为 cwd
curl -X POST http://localhost:18795/backend-api/claude-code/cli/start \
  -H "Content-Type: application/json" \
  -d '{"name": "code"}'

# 也可以手动指定 cwd 覆盖默认值
curl -X POST http://localhost:18795/backend-api/claude-code/cli/start \
  -H "Content-Type: application/json" \
  -d '{"name": "code", "cwd": "/custom/path"}'
```

## 配置说明

### CLAUDE.md

项目指令文件，Claude Code 启动时自动读取。定义 agent 的角色、规则和行为约束。

### .claude/settings.json

Claude Code 的本地配置文件，支持 hook 配置。示例中 code agent 配置了 `PreToolUse` hook，在执行 Bash 命令前检查是否包含危险操作（如 `rm -rf`、`git push --force`）。

### .claude/rules/

附加规则文件目录。Claude Code 自动加载该目录下所有 `.md` 文件作为补充规则。

### .claude/agents/

Subagent 定义目录。每个 `.md` 文件定义一个可调度的 subagent，包括名称、描述、可用工具和行为指令。
