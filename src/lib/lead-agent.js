/**
 * Lead Agent process management module.
 *
 * The Lead Agent is a persistent Claude CLI session that acts as
 * the "construction foreman" — it receives tasks from the harness
 * and executes them. The harness responsibilities are minimal:
 *   1. Start the Lead Agent CLI process
 *   2. Monitor process liveness
 *   3. Notify OpenClaw if the Lead crashes
 *   4. Relay HTTP messages to/from the Lead
 *   5. Expose status via HTTP API
 *
 * Zero external dependencies — Node.js built-in APIs only.
 * Reuses runClaude() from claude-runner.js for message passing.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { runClaude } from './claude-runner.js';
import { log } from './logger.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ── Internal state ─────────────────────────────────────────────────────

let leadState = {
  sessionId: null,      // Claude CLI session ID
  pid: null,            // PID of the currently active child process (during sendToLead)
  running: false,       // Whether the Lead Agent has been initialized
  startedAt: null,      // ISO timestamp of initialization
  lastActivity: null,   // ISO timestamp of last sendToLead or start
  cwd: null,            // Working directory locked at initialization (CLI sessions are dir-bound)
};

// ── P4-1: Start Lead Agent ─────────────────────────────────────────────

/**
 * Start a new Lead Agent session.
 *
 * Reads the system prompt from `options.systemPromptPath`, spawns the
 * Claude CLI with that prompt, extracts the session_id from the JSON
 * output, and saves it to internal state.
 *
 * @param {object} options
 * @param {string} options.systemPromptPath - Absolute path to the system prompt file
 * @param {string} [options.cwd] - Working directory for the CLI process
 * @param {function} [options.onExit] - Callback: onExit(exitCode, signal)
 * @returns {Promise<{ sessionId: string, pid: number|null }>}
 */
export async function startLeadAgent(options) {
  const { systemPromptPath, cwd, onExit } = options;

  if (leadState.running) {
    log('WARN', 'lead-agent', 'startLeadAgent called but Lead Agent is already running', {
      sessionId: leadState.sessionId,
    });
    return { sessionId: leadState.sessionId, pid: leadState.pid };
  }

  // Read the system prompt file
  let systemPrompt;
  try {
    systemPrompt = await readFile(systemPromptPath, 'utf-8');
  } catch (readErr) {
    log('ERROR', 'lead-agent', 'Failed to read system prompt file', {
      path: systemPromptPath,
      error: readErr.message,
    });
    throw new Error(`Failed to read system prompt file: ${readErr.message}`);
  }

  log('INFO', 'lead-agent', 'Starting Lead Agent', {
    systemPromptPath,
    cwd,
    promptLength: systemPrompt.length,
  });

  // Build args: claude -p "<system prompt>" --output-format json
  // Note: working directory is set via spawn's cwd option, not CLI flag
  const args = ['-p', systemPrompt, '--output-format', 'json'];

  // Spawn the initial session using a raw spawn so we can:
  //   1. Capture the full JSON output to extract session_id
  //   2. Monitor the process lifecycle for crash detection (P4-3)
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: cwd || process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      log('ERROR', 'lead-agent', 'Failed to spawn Lead Agent process', {
        bin: CLAUDE_BIN,
        error: spawnErr.message,
      });
      return reject(new Error(`Failed to spawn Lead Agent: ${spawnErr.message}`));
    }

    log('INFO', 'lead-agent', 'Lead Agent process spawned', { pid: child.pid });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      log('ERROR', 'lead-agent', 'Lead Agent spawn error', { error: err.message });
      resetState();
      reject(new Error(`Lead Agent process error: ${err.message}`));
    });

    child.on('close', (exitCode, signal) => {
      // Parse the output to extract session_id
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseErr) {
        log('WARN', 'lead-agent', 'Failed to parse Lead Agent startup output', {
          preview: stdout.substring(0, 500),
          exitCode,
        });
      }

      const sessionId = parsed?.session_id || parsed?.sessionId || null;

      if (exitCode !== 0 || !sessionId) {
        // P4-3: Crash notification for startup failure
        log('ERROR', 'lead-agent', 'Lead Agent startup failed', {
          exitCode,
          signal,
          stderr: stderr.substring(0, 500),
          hasSessionId: !!sessionId,
        });

        resetState();

        if (exitCode !== 0 && typeof onExit === 'function') {
          try {
            onExit(exitCode, signal);
          } catch (cbErr) {
            log('ERROR', 'lead-agent', 'onExit callback threw during startup failure', {
              error: cbErr.message,
            });
          }
        }

        if (!sessionId && exitCode === 0) {
          return reject(new Error('Lead Agent completed but no session_id found in output'));
        }
        if (exitCode !== 0) {
          return reject(new Error(
            `Lead Agent exited with code ${exitCode}: ${stderr.substring(0, 300)}`
          ));
        }
      }

      // Success: update internal state
      const now = new Date().toISOString();
      leadState = {
        sessionId,
        pid: null, // startup process has exited; pid is tracked during sendToLead
        running: true,
        startedAt: now,
        lastActivity: now,
        cwd: cwd || process.cwd(), // lock cwd — CLI sessions are directory-bound
      };

      log('INFO', 'lead-agent', 'Lead Agent started successfully', {
        sessionId,
        startedAt: now,
      });

      resolve({ sessionId, pid: child.pid });
    });
  });
}

// ── P4-1: Send message to Lead Agent ───────────────────────────────────

/**
 * Send a message to the running Lead Agent using --resume.
 *
 * Reuses the existing `runClaude()` function from claude-runner.js,
 * which handles concurrency control, timeout, and JSON parsing.
 *
 * @param {string} message - The message/task to send
 * @param {object} [options]
 * @param {number} [options.timeout] - Timeout in ms (default: 5 minutes)
 * @param {string} [options.cwd] - Working directory override
 * @returns {Promise<{ ok: boolean, response: string, parsed: object|null, usage: object|null, sessionId: string }>}
 */
export async function sendToLead(message, options = {}) {
  if (!leadState.running || !leadState.sessionId) {
    throw new Error('Lead Agent is not running. Call startLeadAgent() first.');
  }

  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const cwd = leadState.cwd || process.cwd(); // always use the locked cwd from initialization
  const sessionId = leadState.sessionId;

  log('INFO', 'lead-agent', 'Sending message to Lead Agent', {
    sessionId,
    messageLength: message.length,
    timeout,
  });

  // Build args: --resume <sessionId> -p "<message>" --output-format json
  const args = ['--resume', sessionId, '-p', message, '--output-format', 'json'];

  leadState.lastActivity = new Date().toISOString();

  let result;
  try {
    result = await runClaude(args, cwd, timeout);
  } catch (err) {
    log('ERROR', 'lead-agent', 'sendToLead failed', {
      sessionId,
      error: err.message,
    });
    throw err;
  }

  // Update last activity after completion
  leadState.lastActivity = new Date().toISOString();

  // Update session_id if the CLI returned a new one (should be the same)
  if (result.parsed?.session_id) {
    leadState.sessionId = result.parsed.session_id;
  }

  const ok = result.exitCode === 0;
  const response = extractResponseText(result.parsed) || result.stdout || '';

  log(ok ? 'INFO' : 'WARN', 'lead-agent', 'sendToLead completed', {
    sessionId: leadState.sessionId,
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
    sessionId: leadState.sessionId,
  };
}

// ── P4-2: Process monitoring ───────────────────────────────────────────

/**
 * Get the full status of the Lead Agent.
 * @returns {{ running: boolean, sessionId: string|null, pid: number|null, startedAt: string|null, lastActivity: string|null }}
 */
export function getLeadStatus() {
  return {
    running: leadState.running,
    sessionId: leadState.sessionId,
    pid: leadState.pid,
    startedAt: leadState.startedAt,
    lastActivity: leadState.lastActivity,
  };
}

/**
 * Check whether the Lead Agent has been initialized and is ready
 * to accept messages via sendToLead().
 * @returns {boolean}
 */
export function isLeadAlive() {
  return leadState.running && leadState.sessionId !== null;
}

// ── P4-3: State management ─────────────────────────────────────────────

/**
 * Reset internal state to the uninitialized default.
 * Called on crash or explicit teardown.
 */
function resetState() {
  leadState = {
    sessionId: null,
    pid: null,
    running: false,
    startedAt: null,
    lastActivity: null,
    cwd: null,
  };
}

// ── Session restore ────────────────────────────────────────────────────

/**
 * Restore a previously established Lead Agent session.
 *
 * Does NOT re-inject the system prompt. Simply saves the given
 * sessionId to internal state so that subsequent sendToLead()
 * calls use --resume with this session.
 *
 * @param {string} sessionId - An existing Claude CLI session ID
 * @param {object} [options]
 * @param {string} [options.startedAt] - Optional original start time (ISO string)
 * @returns {{ sessionId: string, running: boolean }}
 */
export function restoreLeadAgent(sessionId, options = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('restoreLeadAgent requires a valid sessionId string');
  }

  const now = new Date().toISOString();
  leadState = {
    sessionId,
    pid: null,
    running: true,
    startedAt: options.startedAt || now,
    lastActivity: now,
  };

  log('INFO', 'lead-agent', 'Lead Agent session restored', {
    sessionId,
    startedAt: leadState.startedAt,
  });

  return { sessionId, running: true };
}

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * Extract human-readable response text from a parsed Claude CLI result.
 * The CLI JSON output may nest the text in various locations.
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
