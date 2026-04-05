# CLI Agent Example Configuration

This directory contains complete example workspace configurations for three CLI Agents (general / code / complex).

## Directory Structure

```
claude_setting_example/
  general/
    CLAUDE.md            -- Project instructions for General Agent
    .claude/
      settings.json      -- Minimal configuration
  code/
    CLAUDE.md            -- Project instructions for Code Agent
    .claude/
      settings.json      -- Includes safety hooks (intercepts dangerous commands)
      rules/
        code-standards.md -- Code standards rules
      agents/
        code-reviewer.md  -- Code reviewer subagent definition
  complex/
    CLAUDE.md            -- Project instructions for Complex Agent
    .claude/
      settings.json      -- Minimal configuration
```

## Usage

### 1. Prepare the Workspace

Copy the example configuration to your CLI Agent working directory:

```bash
# Assuming your project root is at /root/my-project
# Create the .cli-workspaces directory (runtime directory)
mkdir -p /root/my-project/.cli-workspaces/general
mkdir -p /root/my-project/.cli-workspaces/code
mkdir -p /root/my-project/.cli-workspaces/complex

# Copy example configs to each agent's workspace
cp -r general/* /root/my-project/.cli-workspaces/general/
cp -r general/.claude /root/my-project/.cli-workspaces/general/

cp -r code/* /root/my-project/.cli-workspaces/code/
cp -r code/.claude /root/my-project/.cli-workspaces/code/

cp -r complex/* /root/my-project/.cli-workspaces/complex/
cp -r complex/.claude /root/my-project/.cli-workspaces/complex/
```

### 2. Customize Configuration

- Edit each agent's `CLAUDE.md` to adjust role descriptions and rules for your project
- Edit `.claude/settings.json` to add project-specific hooks
- Add more rule files under `.claude/rules/`
- Define more subagents under `.claude/agents/`

### 3. Start an Agent

When starting an agent via the `/cli/start` endpoint, if the `.cli-workspaces/{name}/` directory exists,
the system will automatically use that directory as the cwd -- no manual specification needed:

```bash
# Automatically uses .cli-workspaces/code/ as cwd
curl -X POST http://localhost:18795/backend-api/claude-code/cli/start \
  -H "Content-Type: application/json" \
  -d '{"name": "code"}'

# You can also manually specify cwd to override the default
curl -X POST http://localhost:18795/backend-api/claude-code/cli/start \
  -H "Content-Type: application/json" \
  -d '{"name": "code", "cwd": "/custom/path"}'
```

## Configuration Details

### CLAUDE.md

The project instruction file that Claude Code reads automatically on startup. Defines the agent's role, rules, and behavioral constraints.

### .claude/settings.json

Claude Code's local settings file with hooks configuration support. In the example, the code agent is configured with a `PreToolUse` hook that checks whether a Bash command contains dangerous operations (such as `rm -rf` or `git push --force`) before execution.

### .claude/rules/

Directory for additional rule files. Claude Code automatically loads all `.md` files in this directory as supplementary rules.

### .claude/agents/

Subagent definition directory. Each `.md` file defines a dispatchable subagent, including its name, description, available tools, and behavioral instructions.
