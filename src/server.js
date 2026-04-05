#!/usr/bin/env node
/**
 * Backend API server for claude-code-skill CLI
 * Zero external dependencies — Node 18+ built-in APIs only
 *
 * Endpoints are prefixed with /backend-api/claude-code
 * Spawns `claude -p` as child processes for each request
 */

import http from 'node:http';
import { json, parseBody } from './lib/helpers.js';
import { sessions, loadSessionStore } from './lib/session-store.js';
import { getActiveProcesses, getMaxConcurrent } from './lib/claude-runner.js';
import { log } from './lib/logger.js';

// Routes
import {
  handleSessionStart,
  handleSessionSend,
  handleSessionSendStream,
  handleSessionList,
  handleSessionStop,
  handleSessionStatus,
  handleSessionRestart,
  handleSessionHistory,
  handleSessionPause,
  handleSessionResume,
  handleSessionFork,
  handleSessionSearch,
} from './routes/session.js';

import {
  handleBash,
  handleRead,
  handleCall,
  handleBatchRead,
} from './routes/tools.js';

import {
  handleConnect,
  handleDisconnect,
  handleTools,
  handleSessions,
  handleResume,
  handleContinue,
  handleHealth,
} from './routes/claude.js';

import {
  handleTaskSubmit,
  handleTaskStatus,
  handleTasksList,
  handleTaskCancel,
  handleLeadRestart,
  handleLeadStatus,
} from './routes/task.js';

// ── Configuration ───────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '18795');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_CWD = process.env.DEFAULT_CWD || '/root';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// ── Load persisted sessions ─────────────────────────────────────────────

loadSessionStore();

// ── Route dispatch table ────────────────────────────────────────────────

const routes = {
  'POST /connect':             handleConnect,
  'POST /disconnect':          handleDisconnect,
  'GET /tools':                handleTools,
  'GET /sessions':             handleSessions,
  'POST /resume':              handleResume,
  'POST /continue':            handleContinue,
  'POST /session/start':       handleSessionStart,
  'POST /session/send':        handleSessionSend,
  'POST /session/send-stream': handleSessionSendStream,
  'GET /session/list':         handleSessionList,
  'POST /session/stop':        handleSessionStop,
  'POST /session/status':      handleSessionStatus,
  'POST /session/restart':     handleSessionRestart,
  'POST /session/history':     handleSessionHistory,
  'POST /session/pause':       handleSessionPause,
  'POST /session/resume':      handleSessionResume,
  'POST /session/fork':        handleSessionFork,
  'POST /session/search':      handleSessionSearch,
  'POST /bash':                handleBash,
  'POST /read':                handleRead,
  'POST /call':                handleCall,
  'POST /batch-read':          handleBatchRead,
  'POST /task/submit':         handleTaskSubmit,
  'GET /tasks/list':           handleTasksList,
  'POST /lead/restart':        handleLeadRestart,
  'GET /lead/status':          handleLeadStatus,
};

// ── Parameterized route patterns ────────────────────────────────────────
// Routes with dynamic segments that cannot be represented in the exact-match
// dispatch table above. Checked in order when no exact match is found.

const paramRoutes = [
  {
    method: 'GET',
    pattern: /^\/task\/([^/]+)\/status$/,
    handler: handleTaskStatus,
    paramName: 'taskId',
  },
  {
    method: 'POST',
    pattern: /^\/task\/([^/]+)\/cancel$/,
    handler: handleTaskCancel,
    paramName: 'taskId',
  },
];

/**
 * Attempt to match a parameterized route.
 * Returns { handler, params } or null.
 */
function matchParamRoute(method, route) {
  for (const entry of paramRoutes) {
    if (entry.method !== method) continue;
    const match = route.match(entry.pattern);
    if (match) {
      return {
        handler: entry.handler,
        params: { [entry.paramName]: match[1] },
      };
    }
  }
  return null;
}

// ── HTTP Server ─────────────────────────────────────────────────────────

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
    return handleHealth(res);
  }

  // Auth check
  if (AUTH_TOKEN) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      return json(res, { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
  }

  // Strip prefix
  if (!pathname.startsWith(PREFIX)) {
    return json(res, { ok: false, error: `Expected prefix ${PREFIX}`, code: 'INVALID_PREFIX' }, 404);
  }
  const route = pathname.slice(PREFIX.length) || '/';

  const t0 = Date.now();
  log('INFO', 'server', `${method} ${route} received`);
  try {
    const body = method === 'POST' ? await parseBody(req) : {};

    // 1. Try exact-match dispatch table
    const key = `${method} ${route}`;
    const handler = routes[key];
    if (handler) {
      await handler(body, req, res);
    } else {
      // 2. Try parameterized route patterns
      const paramMatch = matchParamRoute(method, route);
      if (paramMatch) {
        // Attach extracted params to req so handlers can read them
        req.params = paramMatch.params;
        await paramMatch.handler(body, req, res);
      } else {
        json(res, { ok: false, error: `Unknown route: ${method} ${route}`, code: 'NOT_FOUND' }, 404);
      }
    }

    log('INFO', 'server', `${method} ${route} completed`, { ms: Date.now() - t0 });
  } catch (err) {
    const status = err.statusCode || 500;
    const code = err.code || 'INTERNAL_ERROR';
    log('ERROR', 'server', `${method} ${route} failed`, { ms: Date.now() - t0, code, error: err.message });
    if (!res.headersSent) {
      json(res, { ok: false, error: err.message, code }, status);
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('INFO', 'server', `Server started on http://127.0.0.1:${PORT}`, {
    prefix: PREFIX,
    claudeBin: CLAUDE_BIN,
    defaultCwd: DEFAULT_CWD,
    auth: AUTH_TOKEN ? 'enabled' : 'disabled',
  });
});
