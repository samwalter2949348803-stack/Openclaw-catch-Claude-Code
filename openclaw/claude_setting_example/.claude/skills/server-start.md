# Skill: 启动服务器

## 描述
启动项目开发服务器，包含端口冲突处理。

## 触发条件
用户要求启动/重启服务器、运行项目、start server

## 步骤

### 1. 检测项目类型和启动命令
按优先级检查：
- `package.json` → 读取 scripts 中的 dev/start 命令
- `pyproject.toml` / `requirements.txt` → 查找入口文件（如 run.py, manage.py, main.py）
- `docker-compose.yml` → `docker-compose up -d`
- `Makefile` → 查找 run/dev/start target

### 2. 检查端口占用
```bash
# Linux/Mac
lsof -i :<PORT> 2>/dev/null
# Windows
netstat -ano | grep ":<PORT>"
```
- 如果端口被占用 → 提示用户是否终止占用进程

### 3. 启动服务
根据步骤 1 检测结果执行对应启动命令。

### 4. 验证
```bash
curl -s http://localhost:<PORT>/health || curl -s http://localhost:<PORT>/
```
返回 200 即启动成功。

## Notes
- 端口号从项目配置中读取，常见默认：Node.js 3000, Python 8000, Go 8080
- 如果项目有 `.env`，确保已加载环境变量
- 如果项目有 `docker-compose.yml`，优先推荐 Docker 方式启动
