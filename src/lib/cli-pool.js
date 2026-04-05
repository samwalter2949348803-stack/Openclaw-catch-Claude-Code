/**
 * Multi-CLI Session Pool Manager.
 *
 * Manages up to MAX_POOL_SIZE named CLI sessions (e.g. "general",
 * "code", "complex"), each with an independent session ID, system
 * prompt, status, and working directory.
 *
 * Built on top of the same primitives as lead-agent.js:
 *   - spawn() for initial session creation (extract session_id)
 *   - runClaude() for subsequent message passing via --resume
 *
 * Zero external dependencies — Node.js built-in APIs only.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { runClaude } from './claude-runner.js';
import { log } from './logger.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_TIMEOUT = parseInt(process.env.LEAD_TIMEOUT || String(5 * 60 * 1000), 10);
const MAX_POOL_SIZE = parseInt(process.env.MAX_CLI_POOL || '3', 10);

const COMPONENT = 'cli-pool';

// ── Session Pool ──────────────────────────────────────────────────────
// name -> session state object

const pool = new Map();

// ── 1. startCli ───────────────────────────────────────────────────────

/**
 * Start a new named CLI session (or return the existing one if already
 * running).
 *
 * If `options.systemPromptPath` is provided, reads the system prompt from
 * that file and injects it via `-p` (backward-compatible behavior).
 *
 * If `options.systemPromptPath` is omitted, the CLI is started with a
 * minimal bootstrap prompt, relying on the CLAUDE.md in the working
 * directory (cwd) for its instructions.
 *
 * @param {string} name - Unique session name (e.g. "general", "code", "complex")
 * @param {object} options
 * @param {string} [options.systemPromptPath] - Absolute path to the system prompt file (optional)
 * @param {string} [options.cwd] - Working directory for the CLI process
 * @param {function} [options.onExit] - Callback: onExit(exitCode, signal)
 * @returns {Promise<{ name: string, sessionId: string, status: string }>}
 */
export async function startCli(name, options = {}) {
  const { systemPromptPath, cwd, onExit } = options;

  // If already active, return existing session
  const existing = pool.get(name);
  if (existing && existing.status !== 'stopped') {
    log('WARN', COMPONENT, 'startCli called but CLI is already active', {
      name,
      sessionId: existing.sessionId,
      status: existing.status,
    });
    return { name, sessionId: existing.sessionId, status: existing.status };
  }

  // Check pool capacity — only count non-stopped entries
  const activeCount = [...pool.values()].filter((s) => s.status !== 'stopped').length;
  if (activeCount >= MAX_POOL_SIZE) {
    const msg = `CLI pool is full (${activeCount}/${MAX_POOL_SIZE}). Stop an existing CLI first.`;
    log('ERROR', COMPONENT, msg, { name, activeNames: [...pool.entries()].filter(([, s]) => s.status !== 'stopped').map(([n]) => n) });
    throw new Error(msg);
  }

  // Build args — systemPromptPath is now optional
  let args;
  if (systemPromptPath) {
    // Backward-compatible: read system prompt file and inject via -p
    let systemPrompt;
    try {
      systemPrompt = await readFile(systemPromptPath, 'utf-8');
    } catch (readErr) {
      log('ERROR', COMPONENT, 'Failed to read system prompt file', {
        name,
        path: systemPromptPath,
        error: readErr.message,
      });
      throw new Error(`Failed to read system prompt file for CLI "${name}": ${readErr.message}`);
    }

    log('INFO', COMPONENT, 'Starting CLI session with injected system prompt', {
      name,
      systemPromptPath,
      cwd,
      promptLength: systemPrompt.length,
    });

    args = ['-p', systemPrompt, '--output-format', 'json', '--dangerously-skip-permissions'];
  } else {
    // No system prompt file — CLI reads instructions from cwd/CLAUDE.md
    log('INFO', COMPONENT, 'Starting CLI session (cwd CLAUDE.md mode)', {
      name,
      cwd,
    });

    args = ['-p', '你好，请开始工作。', '--output-format', 'json', '--dangerously-skip-permissions'];
  }

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const resolvedCwd = cwd || process.cwd();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: resolvedCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      log('ERROR', COMPONENT, 'Failed to spawn CLI process', {
        name,
        bin: CLAUDE_BIN,
        error: spawnErr.message,
      });
      return reject(new Error(`Failed to spawn CLI "${name}": ${spawnErr.message}`));
    }

    log('INFO', COMPONENT, 'CLI process spawned', { name, pid: child.pid });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      log('ERROR', COMPONENT, 'CLI spawn error', { name, error: err.message });
      reject(new Error(`CLI "${name}" process error: ${err.message}`));
    });

    child.on('close', (exitCode, signal) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (_parseErr) {
        log('WARN', COMPONENT, 'Failed to parse CLI startup output', {
          name,
          preview: stdout.substring(0, 500),
          exitCode,
        });
      }

      const sessionId = parsed?.session_id || parsed?.sessionId || null;

      if (exitCode !== 0 || !sessionId) {
        log('ERROR', COMPONENT, 'CLI startup failed', {
          name,
          exitCode,
          signal,
          stderr: stderr.substring(0, 500),
          hasSessionId: !!sessionId,
        });

        if (exitCode !== 0 && typeof onExit === 'function') {
          try {
            onExit(exitCode, signal);
          } catch (cbErr) {
            log('ERROR', COMPONENT, 'onExit callback threw during startup failure', {
              name,
              error: cbErr.message,
            });
          }
        }

        if (!sessionId && exitCode === 0) {
          return reject(new Error(`CLI "${name}" completed but no session_id found in output`));
        }
        if (exitCode !== 0) {
          return reject(new Error(
            `CLI "${name}" exited with code ${exitCode}: ${stderr.substring(0, 300)}`
          ));
        }
      }

      // Success — save to pool
      const now = new Date().toISOString();
      pool.set(name, {
        name,
        sessionId,
        status: 'idle',
        systemPromptPath: systemPromptPath || null,
        cwd: resolvedCwd,
        startedAt: now,
        lastActivity: now,
        onExit: onExit || null,
      });

      log('INFO', COMPONENT, 'CLI session started successfully', {
        name,
        sessionId,
        startedAt: now,
      });

      resolve({ name, sessionId, status: 'idle' });
    });
  });
}

// ── 2. sendToCli ──────────────────────────────────────────────────────

/**
 * Send a message to a named CLI session using --resume.
 *
 * Delegates to runClaude() from claude-runner.js which handles
 * concurrency control, timeout, and JSON parsing.
 *
 * @param {string} name - Session name
 * @param {string} message - The message/task to send
 * @param {object} [options]
 * @param {number} [options.timeout] - Timeout in ms (default: LEAD_TIMEOUT env or 5 min)
 * @returns {Promise<{ ok: boolean, response: string, parsed: object|null, usage: object|null, sessionId: string }>}
 */
export async function sendToCli(name, message, options = {}) {
  const session = pool.get(name);

  if (!session) {
    throw new Error(`CLI "${name}" does not exist. Call startCli("${name}", ...) first.`);
  }

  if (session.status === 'stopped') {
    throw new Error(`CLI "${name}" is stopped. Call startCli("${name}", ...) to restart it.`);
  }

  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const { sessionId, cwd } = session;

  log('INFO', COMPONENT, 'Sending message to CLI', {
    name,
    sessionId,
    messageLength: message.length,
    timeout,
  });

  // Mark as busy
  session.status = 'busy';
  session.lastActivity = new Date().toISOString();

  const args = ['--resume', sessionId, '-p', message, '--output-format', 'json', '--dangerously-skip-permissions'];

  let result;
  try {
    result = await runClaude(args, cwd, timeout);
  } catch (err) {
    // Revert to idle on failure so the session remains usable
    session.status = 'idle';
    log('ERROR', COMPONENT, 'sendToCli failed', {
      name,
      sessionId,
      error: err.message,
    });
    throw err;
  }

  // Update state after completion
  session.status = 'idle';
  session.lastActivity = new Date().toISOString();

  // Update session ID if the CLI returned a new one
  if (result.parsed?.session_id) {
    session.sessionId = result.parsed.session_id;
  }

  const ok = result.exitCode === 0;
  const response = extractResponseText(result.parsed) || result.stdout || '';

  log(ok ? 'INFO' : 'WARN', COMPONENT, 'sendToCli completed', {
    name,
    sessionId: session.sessionId,
    ok,
    exitCode: result.exitCode,
    responseLength: response.length,
    usage: result.usage,
  });

  return {
    ok,
    response,
    parsed: result.parsed,
    usage: result.usage,
    sessionId: session.sessionId,
  };
}

// ── 3. stopCli ────────────────────────────────────────────────────────

/**
 * Stop a named CLI session. Marks the session as "stopped" but retains
 * the sessionId so it can be resumed later via startCli or restoreCli.
 *
 * No process is killed — the CLI operates in per-message (spawn) mode,
 * not as a long-running daemon.
 *
 * @param {string} name - Session name
 * @returns {{ name: string, stopped: boolean }}
 */
export function stopCli(name) {
  const session = pool.get(name);

  if (!session) {
    log('WARN', COMPONENT, 'stopCli called for nonexistent CLI', { name });
    return { name, stopped: false };
  }

  session.status = 'stopped';
  session.lastActivity = new Date().toISOString();

  log('INFO', COMPONENT, 'CLI session stopped', {
    name,
    sessionId: session.sessionId,
  });

  return { name, stopped: true };
}

// ── 4. getCli ─────────────────────────────────────────────────────────

/**
 * Get the state of a named CLI session.
 *
 * @param {string} name - Session name
 * @returns {{ name: string, sessionId: string|null, status: string, cwd: string, startedAt: string, lastActivity: string } | null}
 */
export function getCli(name) {
  const session = pool.get(name);
  if (!session) return null;

  return {
    name: session.name,
    sessionId: session.sessionId,
    status: session.status,
    cwd: session.cwd,
    startedAt: session.startedAt,
    lastActivity: session.lastActivity,
  };
}

// ── 5. listClis ───────────────────────────────────────────────────────

/**
 * List all CLI sessions in the pool.
 *
 * @returns {Array<{ name: string, status: string, sessionId: string|null, lastActivity: string|null }>}
 */
export function listClis() {
  const result = [];
  for (const session of pool.values()) {
    result.push({
      name: session.name,
      status: session.status,
      sessionId: session.sessionId,
      lastActivity: session.lastActivity,
    });
  }
  return result;
}

// ── 6. restoreCli ─────────────────────────────────────────────────────

/**
 * Restore a previously established CLI session without re-injecting
 * the system prompt. Saves the given sessionId so that subsequent
 * sendToCli() calls use --resume with this session.
 *
 * @param {string} name - Session name
 * @param {string} sessionId - An existing Claude CLI session ID
 * @param {object} [options]
 * @param {string} [options.cwd] - Working directory
 * @param {string} [options.startedAt] - Original start time (ISO string)
 * @param {string} [options.systemPromptPath] - Path to system prompt (for metadata only)
 * @returns {{ name: string, sessionId: string, status: string }}
 */
export function restoreCli(name, sessionId, options = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('restoreCli requires a valid sessionId string');
  }

  // Check pool capacity — only count non-stopped entries, exclude self if already present
  const activeCount = [...pool.entries()]
    .filter(([n, s]) => s.status !== 'stopped' && n !== name)
    .length;
  if (activeCount >= MAX_POOL_SIZE) {
    const msg = `CLI pool is full (${activeCount}/${MAX_POOL_SIZE}). Stop an existing CLI first.`;
    log('ERROR', COMPONENT, msg, { name });
    throw new Error(msg);
  }

  const now = new Date().toISOString();

  pool.set(name, {
    name,
    sessionId,
    status: 'idle',
    systemPromptPath: options.systemPromptPath || null,
    cwd: options.cwd || process.cwd(),
    startedAt: options.startedAt || now,
    lastActivity: now,
    onExit: null,
  });

  log('INFO', COMPONENT, 'CLI session restored', {
    name,
    sessionId,
    startedAt: pool.get(name).startedAt,
  });

  return { name, sessionId, status: 'idle' };
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Extract human-readable response text from a parsed Claude CLI result.
 * Same logic as lead-agent.js for consistency.
 */
function extractResponseText(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // Direct result text
  if (typeof parsed.result === 'string') return parsed.result;

  // result.text
  if (parsed.result?.text) return parsed.result.text;

  // message.content array (assistant messages)
  if (Array.isArray(parsed.message?.content)) {
    const textBlocks = parsed.message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text);
    if (textBlocks.length > 0) return textBlocks.join('\n');
  }

  // content array at top level
  if (Array.isArray(parsed.content)) {
    const textBlocks = parsed.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text);
    if (textBlocks.length > 0) return textBlocks.join('\n');
  }

  return null;
}
