/**
 * Claude route handlers — /resume, /continue, /sessions, /health, /connect, /disconnect, /tools.
 * Top-level Claude CLI operations not tied to named sessions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { json } from '../lib/helpers.js';
import { runClaude, getActiveProcesses, getMaxConcurrent } from '../lib/claude-runner.js';
import { sessions } from '../lib/session-store.js';
import { log } from '../lib/logger.js';

const DEFAULT_CWD = process.env.DEFAULT_CWD || '/root';
const DEFAULT_TIMEOUT = 120_000;

/** Get the directory where Claude stores JSONL session files. */
function getSessionsDir() {
  if (process.env.CLAUDE_SESSIONS_DIR) return process.env.CLAUDE_SESSIONS_DIR;
  const cwdSlug = DEFAULT_CWD.replace(/\//g, '-');
  return path.join(process.env.HOME || '/root', '.claude', 'projects', cwdSlug);
}

/** Read first N bytes of a file to extract metadata without loading entire file. */
function readHead(filePath, bytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const bytesRead = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } catch (err) {
    log('WARN', 'claude', 'Failed to read file head', { file: filePath, error: err.message });
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Read session JSONL files and extract metadata. */
async function listClaudeSessions() {
  try {
    const sessionsDir = getSessionsDir();
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    const results = [];
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(sessionsDir, file);
      const stat = fs.statSync(filePath);

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
        } catch (parseErr) {
          // Individual line parse failures are expected for partial reads; skip silently
        }
      }

      const estimatedMessages = Math.max(lines.length, Math.round(stat.size / 1024));

      results.push({
        sessionId,
        summary,
        projectPath,
        modified: stat.mtime.toISOString(),
        messageCount: estimatedMessages,
      });
    }
    results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return results;
  } catch (err) {
    log('ERROR', 'claude', 'Failed to list Claude sessions', { error: err.message });
    return [];
  }
}

// Static tools list
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

/** POST /connect */
export function handleConnect(body, req, res) {
  return json(res, { ok: true, status: 'connected', server: { name: 'claude-backend-api' }, tools: TOOLS.length });
}

/** POST /disconnect */
export function handleDisconnect(body, req, res) {
  return json(res, { ok: true });
}

/** GET /tools */
export function handleTools(body, req, res) {
  return json(res, { ok: true, tools: TOOLS });
}

/** GET /sessions — list JSONL sessions from disk */
export async function handleSessions(body, req, res) {
  try {
    const claudeSessions = await listClaudeSessions();
    return json(res, { ok: true, sessions: claudeSessions });
  } catch (err) {
    log('ERROR', 'claude', 'Failed to list sessions', { error: err.message });
    return json(res, { ok: false, error: err.message, code: 'LIST_SESSIONS_FAILED' }, 500);
  }
}

/** POST /resume — resume an existing session by ID */
export async function handleResume(body, req, res) {
  const { sessionId, prompt, cwd } = body;
  if (!sessionId || !prompt) return json(res, { ok: false, error: 'sessionId and prompt required', code: 'MISSING_PARAM' }, 400);
  try {
    const result = await runClaude(
      ['--resume', sessionId, '-p', prompt, '--output-format', 'json'],
      cwd || DEFAULT_CWD, body.timeout || DEFAULT_TIMEOUT
    );
    const output = result.parsed?.result || result.stdout;
    return json(res, { ok: true, output, stderr: result.stderr, session_id: result.parsed?.session_id });
  } catch (err) {
    log('ERROR', 'claude', 'Error resuming session', { sessionId, error: err.message });
    return json(res, { ok: false, error: err.message, code: 'RESUME_FAILED' }, 500);
  }
}

/** POST /continue — continue the most recent session */
export async function handleContinue(body, req, res) {
  const { prompt, cwd } = body;
  if (!prompt) return json(res, { ok: false, error: 'prompt required', code: 'MISSING_PARAM' }, 400);
  try {
    const result = await runClaude(
      ['--continue', '-p', prompt, '--output-format', 'json'],
      cwd || DEFAULT_CWD, body.timeout || DEFAULT_TIMEOUT
    );
    const output = result.parsed?.result || result.stdout;
    return json(res, { ok: true, output, stderr: result.stderr, session_id: result.parsed?.session_id });
  } catch (err) {
    log('ERROR', 'claude', 'Error continuing session', { error: err.message });
    return json(res, { ok: false, error: err.message, code: 'CONTINUE_FAILED' }, 500);
  }
}

/** GET /health — server health check (called from src/server.js directly, not via prefix) */
export function handleHealth(res) {
  return json(res, {
    ok: true,
    uptime: process.uptime(),
    activeSessions: sessions.size,
    activeProcesses: getActiveProcesses(),
    maxConcurrent: getMaxConcurrent(),
    timestamp: new Date().toISOString(),
  });
}
