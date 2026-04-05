#!/usr/bin/env python3
"""MCP stdio server v2 — multi-CLI bridge for OpenClaw to Claude Code harness."""

import json, sys, urllib.request, urllib.error

HARNESS = "http://host.docker.internal:18795/backend-api/claude-code"
HEALTH  = "http://host.docker.internal:18795/health"

TOOLS = [
    {"name": "cli_send", "description": "Send a task to a named CLI agent (general/code/complex). Auto-starts if not running.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "enum": ["general", "code", "complex"], "description": "CLI agent name"}, "message": {"type": "string", "description": "Task description"}}, "required": ["name", "message"]}},
    {"name": "cli_start", "description": "Start a named CLI agent.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "enum": ["general", "code", "complex"]}}, "required": ["name"]}},
    {"name": "cli_stop", "description": "Stop a named CLI agent to free resources.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "enum": ["general", "code", "complex"]}}, "required": ["name"]}},
    {"name": "cli_status", "description": "Get status of a named CLI agent.", "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "enum": ["general", "code", "complex"]}}, "required": ["name"]}},
    {"name": "cli_list", "description": "List all CLI agents and their status.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "task_status", "description": "Check a task result by ID.", "inputSchema": {"type": "object", "properties": {"taskId": {"type": "string"}}, "required": ["taskId"]}},
    {"name": "tasks_list", "description": "List all tasks.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "harness_health", "description": "Check harness health.", "inputSchema": {"type": "object", "properties": {}}},
]

def http(method, path, body=None):
    url = HEALTH if path == "/health" else f"{HARNESS}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    timeout = 300 if body and body.get("message") else 30
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def handle_tool(name, args):
    try:
        if name == "cli_send":
            r = http("POST", "/cli/send", {"name": args["name"], "message": args["message"]})
        elif name == "cli_start":
            r = http("POST", "/cli/start", {"name": args["name"]})
        elif name == "cli_stop":
            r = http("POST", "/cli/stop", {"name": args["name"]})
        elif name == "cli_status":
            r = http("GET", f"/cli/{args['name']}/status")
        elif name == "cli_list":
            r = http("GET", "/cli/list")
        elif name == "task_status":
            r = http("GET", f"/task/{args['taskId']}/status")
        elif name == "tasks_list":
            r = http("GET", "/tasks/list")
        elif name == "harness_health":
            r = http("GET", "/health")
        else:
            return [{"type": "text", "text": f"Unknown tool: {name}"}], True
        return [{"type": "text", "text": json.dumps(r, indent=2, ensure_ascii=False)}], False
    except Exception as e:
        return [{"type": "text", "text": f"Error: {e}"}], True

def handle(msg):
    method = msg.get("method", "")
    mid = msg.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "harness-bridge", "version": "2.0.0"}}}
    elif method == "notifications/initialized":
        return None
    elif method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    elif method == "tools/call":
        content, err = handle_tool(msg["params"]["name"], msg["params"].get("arguments", {}))
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": content, "isError": err}}
    elif mid is not None:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Unknown: {method}"}}
    return None

def send(resp):
    if resp is None: return
    body = json.dumps(resp)
    sys.stdout.write(f"Content-Length: {len(body)}\r\n\r\n{body}")
    sys.stdout.flush()

def main():
    while True:
        line = sys.stdin.readline()
        if not line: return
        line = line.strip()
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
            sys.stdin.readline()
            body = sys.stdin.read(length)
            send(handle(json.loads(body)))
        elif line.startswith("{"):
            resp = handle(json.loads(line))
            if resp:
                sys.stdout.write(json.dumps(resp) + "\n")
                sys.stdout.flush()

if __name__ == "__main__":
    main()
