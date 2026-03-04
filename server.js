#!/usr/bin/env node
/**
 * Backend API server for claude-code-skill CLI
 * Zero external dependencies — Node 18+ built-in APIs only
 *
 * Endpoints are prefixed with /backend-api/claude-code
 * Spawns `claude -p` as child processes for each request
 */

import http from 'node:http';
import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = parseInt(process.env.PORT || '18795');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_CWD = process.env.DEFAULT_CWD || '/root';
const DEFAULT_TIMEOUT = 120_000;
const SESSIONS_DIR = process.env.CLAUDE_SESSIONS_DIR ||
  path.join(process.env.HOME || '/root', '.claude', 'projects', '-root');
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // Set to require Bearer token auth
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3');
const SESSION_STORE_PATH = path.join(
  process.env.HOME || '/root', '.claude', 'session-store.json'
);

// In-memory session store: name → { sessionId, cwd, created, lastActivity, config, turns }
const sessions = new Map();
let activeProcesses = 0;

// Per-session lock: name → Promise (serializes requests to the same session)
const sessionLocks = new Map();

/** Acquire a per-session lock. Returns a release function. */
function acquireSessionLock(name) {
  const prev = sessionLocks.get(name) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  sessionLocks.set(name, next);
  return prev.then(() => release);
}

// ── Session persistence ─────────────────────────────────────────────────

function saveSessionStore() {
  try {
    const data = {};
    for (const [name, sess] of sessions) {
      data[name] = sess;
    }
    fs.writeFileSync(SESSION_STORE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[STORE] Failed to save sessions:', err.message);
  }
}

function loadSessionStore() {
  try {
    if (!fs.existsSync(SESSION_STORE_PATH)) return;
    const data = JSON.parse(fs.readFileSync(SESSION_STORE_PATH, 'utf-8'));
    for (const [name, sess] of Object.entries(data)) {
      sessions.set(name, sess);
    }
    console.log(`[STORE] Loaded ${sessions.size} sessions from disk`);
  } catch (err) {
    console.error('[STORE] Failed to load sessions:', err.message);
  }
}

loadSessionStore();

// ── Helpers ──────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** Spawn claude CLI, return { stdout, stderr, exitCode, parsed } */
function runClaude(args, cwd = DEFAULT_CWD, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (activeProcesses >= MAX_CONCURRENT) {
      return reject(new Error(`Too many concurrent requests (${activeProcesses}/${MAX_CONCURRENT}). Try again later.`));
    }
    activeProcesses++;

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    console.log(`[SPAWN] ${CLAUDE_BIN} ${args.join(' ')} (cwd=${cwd}, timeout=${timeout}ms, active=${activeProcesses}/${MAX_CONCURRENT})`);
    const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[SPAWN] PID=${child.pid}`);

    let stdout = '', stderr = '', done = false;
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    const finish = () => { if (!done) { done = true; activeProcesses--; } };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish();
      reject(new Error(`Claude timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', code => {
      finish();
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      resolve({ stdout, stderr, exitCode: code, parsed });
    });
    child.on('error', err => {
      finish();
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Spawn claude CLI for SSE streaming. onDone is called when the stream ends (for releasing locks). */
function streamClaude(args, cwd, timeout, res, onDone) {
  if (activeProcesses >= MAX_CONCURRENT) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `Too many concurrent requests (${activeProcesses}/${MAX_CONCURRENT}). Try again later.` }));
    if (onDone) onDone();
    return;
  }
  activeProcesses++;

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        // stream-json produces objects with a "type" field
        if (obj.type === 'assistant' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text') {
              sendSSE({ type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              sendSSE({ type: 'tool_use', tool: block.name, input: block.input });
            }
          }
        } else if (obj.type === 'result') {
          // Final result — don't re-emit text (already streamed above)
          sendSSE({ type: 'done', session_id: obj.session_id });
        } else if (obj.type === 'tool_result') {
          sendSSE({ type: 'tool_result' });
        } else {
          // Forward other event types
          sendSSE(obj);
        }
      } catch {
        // Non-JSON line, send as text
        if (line.trim()) sendSSE({ type: 'text', text: line });
      }
    }
  });

  let stderrBuf = '';
  child.stderr.on('data', d => stderrBuf += d);

  let streamDone = false;
  const finishStream = () => { if (!streamDone) { streamDone = true; activeProcesses--; if (onDone) onDone(); } };

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finishStream();
    sendSSE({ type: 'error', error: 'Timed out' });
    res.end();
  }, timeout);

  child.on('close', code => {
    finishStream();
    clearTimeout(timer);
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer);
        if (obj.type === 'result') {
          sendSSE({ type: 'done', session_id: obj.session_id });
        } else {
          sendSSE(obj);
        }
      } catch {
        if (buffer.trim()) sendSSE({ type: 'text', text: buffer });
      }
    }
    if (code !== 0 && stderrBuf) {
      sendSSE({ type: 'error', error: stderrBuf.trim() });
    }
    sendSSE({ type: 'done' });
    res.end();
  });

  child.on('error', err => {
    finishStream();
    clearTimeout(timer);
    sendSSE({ type: 'error', error: err.message });
    res.end();
  });

  // If client disconnects, kill child
  res.on('close', () => {
    finishStream();
    clearTimeout(timer);
    child.kill('SIGTERM');
  });
}

/** Read first N bytes of a file to extract metadata without loading entire file */
function readHead(filePath, bytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const bytesRead = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Read session JSONL files and extract metadata (reads only first 8KB per file) */
async function listClaudeSessions() {
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
    const results = [];
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(SESSIONS_DIR, file);
      const stat = fs.statSync(filePath);

      // Read only first 8KB to get metadata
      let summary = '', projectPath = '';
      const head = readHead(filePath);
      const lines = head.split('\n').filter(l => l.trim());
      for (const line of lines.slice(0, 10)) {
        try {
          const obj = JSON.parse(line);
          if (obj.cwd) projectPath = obj.cwd;
          if (obj.type === 'user' && obj.message?.content) {
            const text = typeof obj.message.content === 'string'
              ? obj.message.content
              : obj.message.content.find(c => c.type === 'text')?.text || '';
            if (text && !summary) {
              summary = text.substring(0, 100).replace(/\n/g, ' ');
            }
          }
        } catch {}
      }

      // Estimate message count from file size (avg ~1KB per line)
      const estimatedMessages = Math.max(lines.length, Math.round(stat.size / 1024));

      results.push({
        sessionId,
        summary,
        projectPath,
        modified: stat.mtime.toISOString(),
        messageCount: estimatedMessages,
      });
    }
    // Sort by modified date, newest first
    results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return results;
  } catch {
    return [];
  }
}

/** Build claude CLI args for a session */
function buildClaudeArgs(body, isStream = false) {
  const args = [];

  if (body.sessionId) {
    args.push('--resume', body.sessionId);
  }

  args.push('-p', body.prompt || body.message || '');

  if (isStream) {
    args.push('--output-format', 'stream-json', '--verbose');
  } else {
    args.push('--output-format', 'json');
  }

  if (body.model) args.push('--model', body.model);
  if (body.permissionMode) args.push('--permission-mode', body.permissionMode);
  if (body.systemPrompt) args.push('--system-prompt', body.systemPrompt);
  if (body.appendSystemPrompt) args.push('--append-system-prompt', body.appendSystemPrompt);
  if (body.maxTurns) args.push('--max-turns', String(body.maxTurns));
  if (body.maxBudgetUsd) args.push('--max-budget-usd', String(body.maxBudgetUsd));
  if (body.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  if (body.forkSession) args.push('--fork-session');
  if (body.customSessionId) args.push('--session-id', body.customSessionId);

  if (body.allowedTools?.length) {
    args.push('--allowed-tools', ...body.allowedTools);
  }
  if (body.disallowedTools?.length) {
    args.push('--disallowed-tools', ...body.disallowedTools);
  }
  if (body.tools?.length) {
    args.push('--tools', ...body.tools);
  }
  if (body.addDir?.length) {
    args.push('--add-dir', ...body.addDir);
  }
  if (body.agents) {
    args.push('--agents', JSON.stringify(body.agents));
  }
  if (body.agent) args.push('--agent', body.agent);

  return args;
}

// ── Static tools list ────────────────────────────────────────────────────

const TOOLS = [
  { name: 'Bash', description: 'Execute bash commands' },
  { name: 'Read', description: 'Read file contents' },
  { name: 'Write', description: 'Write file contents' },
  { name: 'Edit', description: 'Edit file contents with search/replace' },
  { name: 'Glob', description: 'Search for files by pattern' },
  { name: 'Grep', description: 'Search file contents with regex' },
  { name: 'Agent', description: 'Launch sub-agents for complex tasks' },
  { name: 'WebSearch', description: 'Search the web' },
  { name: 'WebFetch', description: 'Fetch web page content' },
];

// ── Route handler ────────────────────────────────────────────────────────

async function handleRoute(method, route, body, req, res) {
  // ── Connection (no-op) ──
  if (route === '/connect' && method === 'POST') {
    return json(res, { ok: true, status: 'connected', server: { name: 'claude-backend-api' }, tools: TOOLS.length });
  }

  if (route === '/disconnect' && method === 'POST') {
    return json(res, { ok: true });
  }

  // ── Tools ──
  if (route === '/tools' && method === 'GET') {
    return json(res, { ok: true, tools: TOOLS });
  }

  // ── List JSONL sessions ──
  if (route === '/sessions' && method === 'GET') {
    const sessions = await listClaudeSessions();
    return json(res, { ok: true, sessions });
  }

  // ── Resume existing session ──
  if (route === '/resume' && method === 'POST') {
    const { sessionId, prompt, cwd } = body;
    if (!sessionId || !prompt) return json(res, { ok: false, error: 'sessionId and prompt required' }, 400);
    try {
      const result = await runClaude(
        ['--resume', sessionId, '-p', prompt, '--output-format', 'json'],
        cwd || DEFAULT_CWD, body.timeout || DEFAULT_TIMEOUT
      );
      const output = result.parsed?.result || result.stdout;
      return json(res, { ok: true, output, stderr: result.stderr, session_id: result.parsed?.session_id });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // ── Continue most recent session ──
  if (route === '/continue' && method === 'POST') {
    const { prompt, cwd } = body;
    if (!prompt) return json(res, { ok: false, error: 'prompt required' }, 400);
    try {
      const result = await runClaude(
        ['--continue', '-p', prompt, '--output-format', 'json'],
        cwd || DEFAULT_CWD, body.timeout || DEFAULT_TIMEOUT
      );
      const output = result.parsed?.result || result.stdout;
      return json(res, { ok: true, output, stderr: result.stderr, session_id: result.parsed?.session_id });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // ── Session: start ──
  if (route === '/session/start' && method === 'POST') {
    const name = body.name;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);

    const cwd = body.cwd || DEFAULT_CWD;

    // Build args for an initial prompt to bootstrap session
    const initPrompt = 'You are ready. Reply with: "Session initialized."';
    const args = buildClaudeArgs({ ...body, prompt: initPrompt });

    try {
      const result = await runClaude(args, cwd, body.timeout || DEFAULT_TIMEOUT);
      const sessionId = result.parsed?.session_id || null;

      sessions.set(name, {
        sessionId,
        cwd,
        created: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        config: body,
        turns: 0,
      });
      saveSessionStore();

      return json(res, { ok: true, claudeSessionId: sessionId });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // ── Session: send (non-streaming) ──
  if (route === '/session/send' && method === 'POST') {
    const { name, message, timeout } = body;
    if (!name || !message) return json(res, { ok: false, error: 'name and message required' }, 400);

    const sess = sessions.get(name);
    if (!sess) return json(res, { ok: false, error: `Session '${name}' not found` }, 404);

    // Serialize requests to the same session to prevent concurrent resume conflicts
    const release = await acquireSessionLock(name);
    try {
      const args = ['--resume', sess.sessionId, '-p', message, '--output-format', 'json'];
      if (sess.config?.permissionMode) args.push('--permission-mode', sess.config.permissionMode);
      if (sess.config?.allowedTools?.length) args.push('--allowed-tools', ...sess.config.allowedTools);
      if (sess.config?.disallowedTools?.length) args.push('--disallowed-tools', ...sess.config.disallowedTools);
      if (sess.config?.model) args.push('--model', sess.config.model);
      if (sess.config?.maxTurns) args.push('--max-turns', String(sess.config.maxTurns));
      if (sess.config?.maxBudgetUsd) args.push('--max-budget-usd', String(sess.config.maxBudgetUsd));
      if (sess.config?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
      if (sess.config?.addDir?.length) args.push('--add-dir', ...sess.config.addDir);

      const result = await runClaude(args, sess.cwd, timeout || DEFAULT_TIMEOUT);
      sess.lastActivity = new Date().toISOString();
      sess.turns++;
      // Update session ID if claude returned a new one
      if (result.parsed?.session_id) sess.sessionId = result.parsed.session_id;
      saveSessionStore();

      const response = result.parsed?.result || result.stdout;
      return json(res, { ok: true, response });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    } finally {
      release();
    }
  }

  // ── Session: send-stream (SSE) ──
  if (route === '/session/send-stream' && method === 'POST') {
    const { name, message, timeout } = body;
    if (!name || !message) return json(res, { ok: false, error: 'name and message required' }, 400);

    const sess = sessions.get(name);
    if (!sess) return json(res, { ok: false, error: `Session '${name}' not found` }, 404);

    // Serialize requests to the same session
    const release = await acquireSessionLock(name);

    const args = ['--resume', sess.sessionId, '-p', message, '--output-format', 'stream-json', '--verbose'];
    if (sess.config?.permissionMode) args.push('--permission-mode', sess.config.permissionMode);
    if (sess.config?.allowedTools?.length) args.push('--allowed-tools', ...sess.config.allowedTools);
    if (sess.config?.disallowedTools?.length) args.push('--disallowed-tools', ...sess.config.disallowedTools);
    if (sess.config?.model) args.push('--model', sess.config.model);
    if (sess.config?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
    if (sess.config?.addDir?.length) args.push('--add-dir', ...sess.config.addDir);

    sess.lastActivity = new Date().toISOString();
    sess.turns++;
    saveSessionStore();

    return streamClaude(args, sess.cwd, timeout || DEFAULT_TIMEOUT, res, release);
  }

  // ── Session: list ──
  if (route === '/session/list' && method === 'GET') {
    const list = [];
    for (const [name, sess] of sessions) {
      list.push({
        name,
        cwd: sess.cwd,
        created: sess.created,
        isReady: !!sess.sessionId,
      });
    }
    return json(res, { ok: true, sessions: list });
  }

  // ── Session: stop ──
  if (route === '/session/stop' && method === 'POST') {
    const { name } = body;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    sessions.delete(name);
    saveSessionStore();
    return json(res, { ok: true });
  }

  // ── Session: status ──
  if (route === '/session/status' && method === 'POST') {
    const { name } = body;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const sess = sessions.get(name);
    if (!sess) return json(res, { ok: false, error: `Session '${name}' not found` }, 404);

    const uptime = Math.floor((Date.now() - new Date(sess.created).getTime()) / 1000);
    return json(res, {
      ok: true,
      claudeSessionId: sess.sessionId,
      cwd: sess.cwd,
      created: sess.created,
      stats: {
        turns: sess.turns,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        uptime,
        lastActivity: sess.lastActivity,
        isReady: !!sess.sessionId,
      },
    });
  }

  // ── Session: history (stub) ──
  if (route === '/session/history' && method === 'POST') {
    return json(res, { ok: true, count: 0, history: [] });
  }

  // ── Session: pause (stub) ──
  if (route === '/session/pause' && method === 'POST') {
    return json(res, { ok: true });
  }

  // ── Session: resume (stub) ──
  if (route === '/session/resume' && method === 'POST') {
    return json(res, { ok: true });
  }

  // ── Session: fork (stub) ──
  if (route === '/session/fork' && method === 'POST') {
    return json(res, { ok: false, error: 'Fork not implemented' }, 501);
  }

  // ── Session: search (stub) ──
  if (route === '/session/search' && method === 'POST') {
    return json(res, { ok: true, sessions: [] });
  }

  // ── Session: restart ──
  if (route === '/session/restart' && method === 'POST') {
    const { name } = body;
    if (!name) return json(res, { ok: false, error: 'name required' }, 400);
    const sess = sessions.get(name);
    if (!sess) return json(res, { ok: false, error: `Session '${name}' not found` }, 404);

    // Re-start with original config
    const cwd = sess.cwd || DEFAULT_CWD;
    const initPrompt = 'You are ready. Reply with: "Session restarted."';
    const args = buildClaudeArgs({ ...sess.config, prompt: initPrompt, sessionId: undefined });

    try {
      const result = await runClaude(args, cwd, DEFAULT_TIMEOUT);
      sess.sessionId = result.parsed?.session_id || null;
      sess.lastActivity = new Date().toISOString();
      sess.turns = 0;
      saveSessionStore();
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // ── Bash (direct execution) ──
  if (route === '/bash' && method === 'POST') {
    const { command } = body;
    if (!command) return json(res, { ok: false, error: 'command required' }, 400);

    return new Promise((resolve) => {
      exec(command, { timeout: DEFAULT_TIMEOUT, cwd: DEFAULT_CWD, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout && !stderr) {
          json(res, { ok: false, error: err.message }, 500);
        } else {
          json(res, { ok: true, result: { stdout: stdout || '', stderr: stderr || '' } });
        }
        resolve();
      });
    });
  }

  // ── Read file ──
  if (route === '/read' && method === 'POST') {
    const { file_path } = body;
    if (!file_path) return json(res, { ok: false, error: 'file_path required' }, 400);
    try {
      const content = fs.readFileSync(file_path, 'utf-8');
      return json(res, { ok: true, result: { type: 'file', file: { content } } });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // ── Call tool (stub) ──
  if (route === '/call' && method === 'POST') {
    return json(res, { ok: false, error: 'Direct tool call not implemented. Use session-send instead.' }, 501);
  }

  // ── Batch read (stub) ──
  if (route === '/batch-read' && method === 'POST') {
    return json(res, { ok: false, error: 'Batch read not implemented' }, 501);
  }

  // ── 404 ──
  return json(res, { ok: false, error: `Unknown route: ${method} ${route}` }, 404);
}

// ── HTTP Server ──────────────────────────────────────────────────────────

const PREFIX = '/backend-api/claude-code';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check (no prefix, no auth)
  if (pathname === '/health') {
    return json(res, {
      ok: true,
      uptime: process.uptime(),
      activeSessions: sessions.size,
      activeProcesses,
      maxConcurrent: MAX_CONCURRENT,
      timestamp: new Date().toISOString(),
    });
  }

  // Auth check
  if (AUTH_TOKEN) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      return json(res, { ok: false, error: 'Unauthorized' }, 401);
    }
  }

  // Strip prefix
  if (!pathname.startsWith(PREFIX)) {
    return json(res, { ok: false, error: `Expected prefix ${PREFIX}` }, 404);
  }
  const route = pathname.slice(PREFIX.length) || '/';

  const t0 = Date.now();
  console.log(`[REQ] ${method} ${route}`);
  try {
    const body = method === 'POST' ? await parseBody(req) : {};
    await handleRoute(method, route, body, req, res);
    console.log(`[RES] ${method} ${route} ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[ERROR] ${method} ${route} ${Date.now() - t0}ms:`, err);
    if (!res.headersSent) {
      json(res, { ok: false, error: err.message }, 500);
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-code-skill backend-api listening on http://127.0.0.1:${PORT}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Claude binary: ${CLAUDE_BIN}`);
  console.log(`Default CWD: ${DEFAULT_CWD}`);
  console.log(`Auth: ${AUTH_TOKEN ? 'enabled' : 'disabled (set AUTH_TOKEN to enable)'}`);
});
