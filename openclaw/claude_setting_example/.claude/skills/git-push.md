# Skill: Git Push

## Description
将本地代码推送到 GitHub 远程仓库。

## Trigger
用户要求 git push、推送代码、上传到 GitHub 时触发。

## Steps

1. **检查状态**
   ```bash
   git status
   git log --oneline -3
   git remote -v
   ```

2. **暂存文件**
   - 逐个添加需要提交的文件，不要用 `git add -A` 或 `git add .`
   - **绝对不要暂存**: `.env`、`credentials.json`、包含密钥的文件
   - 确认 `.gitignore` 已排除敏感文件

3. **提交**
   - 用 HEREDOC 格式写 commit message，避免引号转义问题
   - 格式：简短标题 + 空行 + 要点列表
   - 末尾加 `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
   ```bash
   git commit -m "$(cat <<'EOF'
   标题

   - 要点1
   - 要点2

   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
   EOF
   )"
   ```

4. **配置远程（如需要）**
   - 如果 remote 未配置，从 `.env` 读取 `GITHUB_USERNAME`、`GITHUB_TOKEN`、`GITHUB_REPO`
   - 设置格式: `https://<GITHUB_USERNAME>:<GITHUB_TOKEN>@github.com/<GITHUB_USERNAME>/<GITHUB_REPO>.git`
   ```bash
   git remote add origin https://$GITHUB_USERNAME:$GITHUB_TOKEN@github.com/$GITHUB_USERNAME/$GITHUB_REPO.git
   ```
   - 如果 remote 已存在但 URL 不对，用 `git remote set-url origin <url>` 修改

5. **推送**
   ```bash
   git push origin main
   ```

6. **验证**
   ```bash
   git status
   git log --oneline -1
   ```

7. **更新文档（自动执行，不要跳过）**
   - 执行 `.claude/skills/update-docs.md` 中的所有步骤
   - 更新状态逻辑图.md（如有架构变更）
   - 追加工作日志条目（每次必做）

## Notes
- 推送前确认当前分支（通常是 `main`）
- 如果推送被拒绝（non-fast-forward），先 `git pull --rebase origin main` 再推送
- 不要使用 `--force` 除非用户明确要求
- Token 信息仅从 `.env` 读取，不要硬编码
