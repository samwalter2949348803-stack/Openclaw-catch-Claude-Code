/**
 * Session route handlers — /session/* endpoints.
 * Manages named sessions backed by Claude CLI session IDs.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { json, buildClaudeArgs } from '../lib/helpers.js';
import { sessions, sessionLocks, acquireSessionLock, saveSessionStore } from '../lib/session-store.js';
import { runClaude, streamClaude } from '../lib/claude-runner.js';
import { log } from '../lib/logger.js';

const DEFAULT_CWD = process.env.DEFAULT_CWD || '/root';
const DEFAULT_TIMEOUT = 120_000;

/**
 * Accumulate token usage onto a session object.
 * Safe to call with null usage — it simply does nothing.
 */
function accumulateUsage(sess, usage) {
  if (!usage) return;
  if (typeof usage.inputTokens === 'number') {
    sess.tokensIn = (sess.tokensIn || 0) + usage.inputTokens;
  }
  if (typeof usage.outputTokens === 'number') {
    sess.tokensOut = (sess.tokensOut || 0) + usage.outputTokens;
  }
}

/* ------------------------------------------------------------------ */
/*  Session history helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Locate the JSONL session file for a given Claude session ID.
 * Searches all project directories under ~/.claude/projects/.
 * Returns the absolute path if found, or null.
 */
function findSessionJsonlPath(sessionId) {
  const claudeDir = path.join(process.env.HOME || '/root', '.claude', 'projects');
  try {
    if (!fs.existsSync(claudeDir)) return null;
    const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(claudeDir, entry.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (err) {
    log('WARN', 'session-history', 'Error searching for JSONL file', { sessionId, error: err.message });
  }
  return null;
}

/**
 * Extract a plain-text summary from a message content field.
 * Content can be a string or an array of content blocks.
 * Returns { text, blocks } where blocks is a lightweight type-only array.
 */
function extractContent(content) {
  if (typeof content === 'string') return { text: content, blocks: null };
  if (!Array.isArray(content)) return { text: '', blocks: null };

  const textParts = [];
  const blocks = [];

  for (const block of content) {
    blocks.push({ type: block.type });
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    }
  }

  return { text: textParts.join('\n'), blocks };
}

/**
 * Stream-parse a JSONL file and collect conversation messages.
 * Only lines with type "user" or "assistant" that carry a message object
 * are included. Uses readline for memory-safe line-by-line reading.
 *
 * @returns {{ messages: object[], total: number }}
 */
function parseSessionJsonl(filePath, limit, offset) {
  return new Promise((resolve) => {
    const messages = [];
    let lineIndex = 0;

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    stream.on('error', (err) => {
      log('WARN', 'session-history', 'Error reading JSONL stream', { filePath, error: err.message });
      resolve({ messages: [], total: 0 });
    });

    rl.on('line', (line) => {
      lineIndex++;
      if (!line.trim()) return;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        log('WARN', 'session-history', 'Failed to parse JSONL line', { lineIndex, error: err.message });
        return;
      }

      // Only keep user and assistant conversation messages
      const type = obj.type;
      if (type !== 'user' && type !== 'assistant') return;

      const msg = obj.message;
      if (!msg || !msg.content) return;

      const { text, blocks } = extractContent(msg.content);

      messages.push({
        role: msg.role || type,
        text,
        blocks,
        timestamp: obj.timestamp || null,
      });
    });

    rl.on('close', () => {
      const total = messages.length;
      const sliced = messages.slice(offset, offset + limit);
      resolve({ messages: sliced, total });
    });

    rl.on('error', (err) => {
      log('WARN', 'session-history', 'readline error', { filePath, error: err.message });
      resolve({ messages: [], total: 0 });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Route handlers                                                    */
/* ------------------------------------------------------------------ */

/** POST /session/start */
export async function handleSessionStart(body, req, res) {
  const name = body.name;
  if (!name) return json(res, { ok: false, error: 'name required', code: 'MISSING_PARAM' }, 400);

  const cwd = body.cwd || DEFAULT_CWD;

  const initPrompt = 'You are ready. Reply with: "Session initialized."';
  const args = buildClaudeArgs({ ...body, prompt: initPrompt });

  try {
    const result = await runClaude(args, cwd, body.timeout || DEFAULT_TIMEOUT);
    const sessionId = result.parsed?.session_id || null;

    if (!sessionId) {
      log('ERROR', 'session', 'Claude did not return a session ID', { name, stdout: (result.stdout || '').substring(0, 300) });
      return json(res, { ok: false, error: 'Claude did not return a session ID. Check that the Claude CLI is installed and authenticated.', code: 'NO_SESSION_ID' }, 500);
    }

    sessions.set(name, {
      sessionId,
      cwd,
      created: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      config: body,
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
    });

    // Accumulate any usage from the init call
    const sess = sessions.get(name);
    accumulateUsage(sess, result.usage);

    saveSessionStore();

    return json(res, { ok: true, claudeSessionId: sessionId });
  } catch (err) {
    log('ERROR', 'session', 'Error starting session', { name, error: err.message });
    return json(res, { ok: false, error: err.message, code: 'SESSION_START_FAILED' }, 500);
  }
}

/** POST /session/send */
export async function handleSessionSend(body, req, res) {
  const { name, message, timeout } = body;
  if (!name || !message) return json(res, { ok: false, error: 'name and message required', code: 'MISSING_PARAM' }, 400);

  const sess = sessions.get(name);
  if (!sess) return json(res, { ok: false, error: `Session '${name}' not found`, code: 'SESSION_NOT_FOUND' }, 404);

  if (!sess.sessionId) {
    return json(res, { ok: false, error: `Session '${name}' has no Claude session ID. Try restarting the session.`, code: 'NO_SESSION_ID' }, 400);
  }

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
    if (sess.config?.baseUrl) args.push('--base-url', sess.config.baseUrl);

    const result = await runClaude(args, sess.cwd, timeout || DEFAULT_TIMEOUT);
    sess.lastActivity = new Date().toISOString();
    sess.turns++;
    if (result.parsed?.session_id) sess.sessionId = result.parsed.session_id;

    // Accumulate token usage
    accumulateUsage(sess, result.usage);

    saveSessionStore();

    const response = result.parsed?.result || result.stdout;
    return json(res, { ok: true, response });
  } catch (err) {
    log('ERROR', 'session', 'Error sending to session', { name, error: err.message });
    return json(res, { ok: false, error: err.message, code: 'SESSION_SEND_FAILED' }, 500);
  } finally {
    release();
  }
}

/** POST /session/send-stream */
export async function handleSessionSendStream(body, req, res) {
  const { name, message, timeout } = body;
  if (!name || !message) return json(res, { ok: false, error: 'name and message required', code: 'MISSING_PARAM' }, 400);

  const sess = sessions.get(name);
  if (!sess) return json(res, { ok: false, error: `Session '${name}' not found`, code: 'SESSION_NOT_FOUND' }, 404);

  if (!sess.sessionId) {
    return json(res, { ok: false, error: `Session '${name}' has no Claude session ID. Try restarting the session.`, code: 'NO_SESSION_ID' }, 400);
  }

  const release = await acquireSessionLock(name);

  const args = ['--resume', sess.sessionId, '-p', message, '--output-format', 'stream-json', '--verbose'];
  if (sess.config?.permissionMode) args.push('--permission-mode', sess.config.permissionMode);
  if (sess.config?.allowedTools?.length) args.push('--allowed-tools', ...sess.config.allowedTools);
  if (sess.config?.disallowedTools?.length) args.push('--disallowed-tools', ...sess.config.disallowedTools);
  if (sess.config?.model) args.push('--model', sess.config.model);
  if (sess.config?.maxTurns) args.push('--max-turns', String(sess.config.maxTurns));
  if (sess.config?.maxBudgetUsd) args.push('--max-budget-usd', String(sess.config.maxBudgetUsd));
  if (sess.config?.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  if (sess.config?.addDir?.length) args.push('--add-dir', ...sess.config.addDir);
  if (sess.config?.baseUrl) args.push('--base-url', sess.config.baseUrl);

  return streamClaude(args, sess.cwd, timeout || DEFAULT_TIMEOUT, res, ({ usage }) => {
    sess.lastActivity = new Date().toISOString();
    sess.turns++;

    // Accumulate token usage from stream
    accumulateUsage(sess, usage);

    saveSessionStore();
    release();
  });
}

/** GET /session/list */
export function handleSessionList(body, req, res) {
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

/** POST /session/stop */
export function handleSessionStop(body, req, res) {
  const { name } = body;
  if (!name) return json(res, { ok: false, error: 'name required', code: 'MISSING_PARAM' }, 400);
  sessions.delete(name);
  sessionLocks.delete(name);
  saveSessionStore();
  return json(res, { ok: true });
}

/** POST /session/status */
export function handleSessionStatus(body, req, res) {
  const { name } = body;
  if (!name) return json(res, { ok: false, error: 'name required', code: 'MISSING_PARAM' }, 400);
  const sess = sessions.get(name);
  if (!sess) return json(res, { ok: false, error: `Session '${name}' not found`, code: 'SESSION_NOT_FOUND' }, 404);

  const uptime = Math.floor((Date.now() - new Date(sess.created).getTime()) / 1000);

  // Return null instead of 0 to indicate "unknown" (no usage data received yet)
  const tokensIn = (sess.tokensIn && sess.tokensIn > 0) ? sess.tokensIn : null;
  const tokensOut = (sess.tokensOut && sess.tokensOut > 0) ? sess.tokensOut : null;

  return json(res, {
    ok: true,
    claudeSessionId: sess.sessionId,
    cwd: sess.cwd,
    created: sess.created,
    stats: {
      turns: sess.turns,
      toolCalls: 0,
      tokensIn,
      tokensOut,
      uptime,
      lastActivity: sess.lastActivity,
      isReady: !!sess.sessionId,
    },
  });
}

/** POST /session/restart */
export async function handleSessionRestart(body, req, res) {
  const { name } = body;
  if (!name) return json(res, { ok: false, error: 'name required', code: 'MISSING_PARAM' }, 400);
  const sess = sessions.get(name);
  if (!sess) return json(res, { ok: false, error: `Session '${name}' not found`, code: 'SESSION_NOT_FOUND' }, 404);

  const cwd = sess.cwd || DEFAULT_CWD;
  const initPrompt = 'You are ready. Reply with: "Session restarted."';
  const args = buildClaudeArgs({ ...sess.config, prompt: initPrompt, sessionId: undefined });

  try {
    const result = await runClaude(args, cwd, DEFAULT_TIMEOUT);
    const newSessionId = result.parsed?.session_id || null;
    if (!newSessionId) {
      log('ERROR', 'session', 'Claude did not return a session ID during restart', { name, stdout: (result.stdout || '').substring(0, 300) });
      return json(res, { ok: false, error: 'Claude did not return a session ID during restart. Check that the Claude CLI is installed and authenticated.', code: 'NO_SESSION_ID' }, 500);
    }
    sess.sessionId = newSessionId;
    sess.lastActivity = new Date().toISOString();
    sess.turns = 0;
    // Reset token counters on restart
    sess.tokensIn = 0;
    sess.tokensOut = 0;
    saveSessionStore();
    return json(res, { ok: true });
  } catch (err) {
    log('ERROR', 'session', 'Error restarting session', { name, error: err.message });
    return json(res, { ok: false, error: err.message, code: 'SESSION_RESTART_FAILED' }, 500);
  }
}

/** POST /session/history */
export async function handleSessionHistory(body, req, res) {
  const { name } = body;
  if (!name) return json(res, { ok: false, error: 'name required', code: 'MISSING_PARAM' }, 400);

  const sess = sessions.get(name);
  if (!sess) return json(res, { ok: false, error: `Session '${name}' not found`, code: 'SESSION_NOT_FOUND' }, 404);

  if (!sess.sessionId) {
    return json(res, { ok: false, error: `Session '${name}' has no Claude session ID`, code: 'NO_SESSION_ID' }, 400);
  }

  // Pagination params with bounds
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(body.offset, 10) || 0, 0);

  // Locate the JSONL file for this session
  const jsonlPath = findSessionJsonlPath(sess.sessionId);
  if (!jsonlPath) {
    log('DEBUG', 'session-history', 'JSONL file not found, returning empty history', { sessionId: sess.sessionId });
    return json(res, { ok: true, count: 0, history: [], total: 0 });
  }

  try {
    const { messages, total } = await parseSessionJsonl(jsonlPath, limit, offset);
    return json(res, {
      ok: true,
      count: messages.length,
      history: messages,
      total,
    });
  } catch (err) {
    log('ERROR', 'session-history', 'Error parsing session history', { sessionId: sess.sessionId, error: err.message });
    return json(res, { ok: false, error: 'Failed to read session history', code: 'HISTORY_READ_FAILED' }, 500);
  }
}

/** POST /session/pause (stub 501) */
export function handleSessionPause(body, req, res) {
  return json(res, { ok: false, error: 'Not implemented', code: 'NOT_IMPLEMENTED', endpoint: '/session/pause' }, 501);
}

/** POST /session/resume (stub 501) */
export function handleSessionResume(body, req, res) {
  return json(res, { ok: false, error: 'Not implemented', code: 'NOT_IMPLEMENTED', endpoint: '/session/resume' }, 501);
}

/** POST /session/fork (stub 501) */
export function handleSessionFork(body, req, res) {
  return json(res, { ok: false, error: 'Not implemented', code: 'NOT_IMPLEMENTED', endpoint: '/session/fork' }, 501);
}

/** POST /session/search (stub 501) */
export function handleSessionSearch(body, req, res) {
  return json(res, { ok: false, error: 'Not implemented', code: 'NOT_IMPLEMENTED', endpoint: '/session/search' }, 501);
}
