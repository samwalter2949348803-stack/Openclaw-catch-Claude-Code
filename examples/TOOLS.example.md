# 环境信息

## 服务器

- 远程服务器：`ssh user@your-server-ip`
- 项目路径：`/path/to/your/project/`

## SSH 运维命令示例

```bash
bash command:"ssh user@your-server-ip 'cd /path/to/your/project && git pull origin main'"
bash command:"ssh user@your-server-ip 'cd /path/to/your/project && git push origin main'"
bash command:"ssh user@your-server-ip 'cd /path/to/your/project && sudo docker compose restart backend frontend'"
bash command:"ssh user@your-server-ip 'cd /path/to/your/project && sudo docker compose logs --tail 50 backend'"
```
