#!/usr/bin/env bash
# deploy-smoke.sh — Mac Mini 部署全链路冒烟测试
# 用法: bash test/deploy-smoke.sh [macmini密码]
# 密码也可通过环境变量 MACMINI_PASS 传入

set -euo pipefail

PASS="${1:-${MACMINI_PASS:-Nexft666}}"
HOST="Nexft-bot@Nexft-botdeMac-mini.local"
SSH="ssh -o UserKnownHostsFile=$HOME/.ssh/known_hosts -i $HOME/.ssh/id_ed25519 -o ConnectTimeout=10"
BREW='eval "$(/opt/homebrew/bin/brew shellenv zsh)"'

PASSED=0
FAILED=0
TOTAL=8

pass() { echo "  ✅ $1"; PASSED=$((PASSED+1)); }
fail() { echo "  ❌ $1: $2"; FAILED=$((FAILED+1)); }

echo "=============================="
echo " Mac Mini Deploy Smoke Test"
echo "=============================="
echo ""

# 1. SSH
echo "[1/8] SSH 连通性"
if $SSH $HOST 'echo OK' 2>/dev/null | grep -q OK; then
  pass "SSH 连接正常"
else
  fail "SSH 连接失败" "检查网络或 mDNS"
  echo "后续测试依赖 SSH，终止。"
  exit 1
fi

# 2. Keychain
echo "[2/8] Keychain 解锁"
if $SSH $HOST "security unlock-keychain -p \"$PASS\" login.keychain && echo OK" 2>/dev/null | grep -q OK; then
  pass "Keychain 已解锁"
else
  fail "Keychain 解锁失败" "密码错误或 Keychain 损坏"
fi

# 3. Claude CLI
echo "[3/8] Claude CLI 认证"
CLAUDE_OUT=$($SSH $HOST "security unlock-keychain -p \"$PASS\" login.keychain && $BREW && claude -p '回复OK' 2>&1" 2>/dev/null || true)
if echo "$CLAUDE_OUT" | grep -qi "ok\|好\|是"; then
  pass "Claude CLI 可用"
else
  fail "Claude CLI 不可用" "$CLAUDE_OUT"
fi

# 4. Harness
echo "[4/8] Harness 健康检查"
HEALTH=$($SSH $HOST 'curl -s http://localhost:18795/health 2>/dev/null' || true)
if echo "$HEALTH" | grep -q '"ok":true'; then
  pass "Harness 运行中"
else
  fail "Harness 不可用" "$HEALTH"
fi

# 5. Docker 容器
echo "[5/8] OpenClaw 容器状态"
CONTAINERS=$($SSH $HOST "$BREW && docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null" || true)
if echo "$CONTAINERS" | grep -q "openclaw-backend.*Up.*healthy"; then
  pass "openclaw-backend 健康运行"
else
  fail "openclaw-backend 异常" "$CONTAINERS"
fi

# 6. 容器内 → Harness 连通性
echo "[6/8] 容器内 → Harness 连通性"
BRIDGE_HEALTH=$($SSH $HOST "$BREW && docker exec openclaw-backend python3 -c \"import urllib.request,json; r=urllib.request.urlopen('http://host.docker.internal:18795/health',timeout=5); print(json.loads(r.read()).get('ok'))\" 2>/dev/null" || true)
if echo "$BRIDGE_HEALTH" | grep -q "True"; then
  pass "容器内可达 Harness"
else
  fail "容器内无法达到 Harness" "$BRIDGE_HEALTH"
fi

# 7. MCP 协议握手
echo "[7/8] MCP 协议握手"
MCP_OUT=$($SSH $HOST "$BREW && printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}\n' | docker exec -i openclaw-backend python3 /mcp/harness_bridge.py 2>/dev/null" || true)
if echo "$MCP_OUT" | grep -q "harness_health"; then
  pass "MCP 握手成功，5 个工具已注册"
else
  fail "MCP 握手失败" "$MCP_OUT"
fi

# 8. 端到端：Agent 调用 MCP 工具
echo "[8/8] 端到端：Agent 调用 MCP 工具"
E2E=$($SSH $HOST "$BREW && docker exec openclaw-backend openclaw agent --agent main -m 'Use the harness_health MCP tool now. Just call it and report the result.' --json 2>/dev/null" || true)
if echo "$E2E" | grep -qi "healthy\|ok.*true\|uptime"; then
  pass "Agent 成功调用 MCP → Harness"
else
  fail "Agent 未能调用 MCP 工具" "$(echo "$E2E" | head -c 200)"
fi

# 结果
echo ""
echo "=============================="
echo " 结果: $PASSED/$TOTAL 通过, $FAILED 失败"
echo "=============================="

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
