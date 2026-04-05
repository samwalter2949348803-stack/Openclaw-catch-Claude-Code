/**
 * CLI route handlers — /cli/* endpoints.
 *
 * Provides the HTTP API for managing multiple named CLI sessions
 * (general, code, complex) via the cli-pool module.
 *
 * Handler signature follows the existing convention: (body, req, res)
 * Zero external dependencies — Node.js built-in APIs only.
 */

import path from 'node:path';
import { json } from '../lib/helpers.js';
import {
  startCli,
  sendToCli,
  stopCli,
  getCli,
  listClis,
} from '../lib/cli-pool.js';
import { log } from '../lib/logger.js';

// ── Constants ──────────────────────────────────────────────────────────

const VALID_CLI_NAMES = ['general', 'code', 'complex'];
const DEFAULT_CWD = process.env.DEFAULT_CWD || '/root';
const DEFAULT_CLI_TIMEOUT = parseInt(process.env.LEAD_TIMEOUT || '300', 10) * 1000;

const COMPONENT = 'cli-route';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Validate that a CLI name is in the allowed whitelist.
 * Returns an error response object if invalid, or null if valid.
 */
function validateCliName(name, res) {
  if (!name || typeof name !== 'string') {
    json(res, {
      ok: false,
      error: 'name is required and must be a string',
      code: 'MISSING_PARAM',
    }, 400);
    return true; // signals that response was sent
  }

  if (!VALID_CLI_NAMES.includes(name)) {
    json(res, {
      ok: false,
      error: `Invalid CLI name "${name}". Must be one of: ${VALID_CLI_NAMES.join(', ')}`,
      code: 'INVALID_CLI_NAME',
      validNames: VALID_CLI_NAMES,
    }, 400);
    return true;
  }

  return false; // valid
}

/**
 * Resolve the system prompt path for a given CLI name.
 */
function getSystemPromptPath(name) {
  return path.resolve(process.cwd(), '.agents', name, 'system.md');
}

// ── POST /cli/start — Start a named CLI session ───────────────────────

/**
 * Start a specific CLI session.
 *
 * Request body:
 *   { name: "general" | "code" | "complex", cwd?: string }
 *
 * Returns:
 *   { ok: true, name, sessionId, status }
 */
export async function handleCliStart(body, req, res) {
  const { name, cwd } = body;

  if (validateCliName(name, res)) return;

  const systemPromptPath = getSystemPromptPath(name);
  const resolvedCwd = cwd || DEFAULT_CWD;

  log('INFO', COMPONENT, 'CLI start requested', { name, cwd: resolvedCwd });

  try {
    const result = await startCli(name, {
      systemPromptPath,
      cwd: resolvedCwd,
      onExit: (exitCode, signal) => {
        log('WARN', COMPONENT, 'CLI session exited', {
          name,
          exitCode,
          signal,
        });
      },
    });

    return json(res, {
      ok: true,
      name: result.name,
      sessionId: result.sessionId,
      status: result.status,
    });
  } catch (err) {
    log('ERROR', COMPONENT, 'Failed to start CLI', {
      name,
      error: err.message,
    });
    return json(res, {
      ok: false,
      error: err.message,
      code: 'CLI_START_FAILED',
    }, 500);
  }
}

// ── POST /cli/send — Send a message to a named CLI ───────────────────

/**
 * Send a message to a specific CLI session.
 *
 * If the CLI is not running, it will be lazily started first.
 *
 * Request body:
 *   { name: string, message: string, timeout?: number }
 *
 * Returns:
 *   { ok: true, name, response, sessionId, usage }
 */
export async function handleCliSend(body, req, res) {
  const { name, message, timeout } = body;

  if (validateCliName(name, res)) return;

  if (!message || typeof message !== 'string') {
    return json(res, {
      ok: false,
      error: 'message is required and must be a string',
      code: 'MISSING_PARAM',
    }, 400);
  }

  // Lazy-start: if CLI is not running, start it automatically
  const existing = getCli(name);
  if (!existing || existing.status === 'stopped') {
    log('INFO', COMPONENT, 'CLI not active, lazy-starting before send', { name });

    const systemPromptPath = getSystemPromptPath(name);
    const resolvedCwd = DEFAULT_CWD;

    try {
      await startCli(name, {
        systemPromptPath,
        cwd: resolvedCwd,
        onExit: (exitCode, signal) => {
          log('WARN', COMPONENT, 'CLI session exited (lazy-started)', {
            name,
            exitCode,
            signal,
          });
        },
      });
    } catch (err) {
      log('ERROR', COMPONENT, 'Failed to lazy-start CLI before send', {
        name,
        error: err.message,
      });
      return json(res, {
        ok: false,
        error: `Failed to start CLI "${name}": ${err.message}`,
        code: 'CLI_START_FAILED',
      }, 500);
    }
  }

  const effectiveTimeout = timeout || DEFAULT_CLI_TIMEOUT;

  try {
    const result = await sendToCli(name, message, { timeout: effectiveTimeout });

    return json(res, {
      ok: result.ok,
      name,
      response: result.response,
      sessionId: result.sessionId,
      usage: result.usage || null,
    });
  } catch (err) {
    // Detect timeout errors
    const isTimeout = err.message?.includes('timed out')
      || err.message?.includes('timeout')
      || err.code === 'TIMEOUT';

    if (isTimeout) {
      log('WARN', COMPONENT, 'sendToCli timed out', {
        name,
        timeout: effectiveTimeout,
        error: err.message,
      });
      return json(res, {
        ok: false,
        error: 'CLI execution timed out',
        code: 'TIMEOUT',
      }, 504);
    }

    log('ERROR', COMPONENT, 'sendToCli failed', {
      name,
      error: err.message,
    });
    return json(res, {
      ok: false,
      error: err.message,
      code: 'CLI_SEND_FAILED',
    }, 500);
  }
}

// ── POST /cli/stop — Stop a named CLI session ────────────────────────

/**
 * Stop a specific CLI session.
 *
 * Request body:
 *   { name: string }
 *
 * Returns:
 *   { ok: true, name, stopped: true }
 */
export async function handleCliStop(body, req, res) {
  const { name } = body;

  if (validateCliName(name, res)) return;

  log('INFO', COMPONENT, 'CLI stop requested', { name });

  const result = stopCli(name);

  return json(res, {
    ok: true,
    name: result.name,
    stopped: result.stopped,
  });
}

// ── GET /cli/:name/status — Get status of a single CLI ───────────────

/**
 * Get the status of a specific CLI session.
 *
 * The name parameter is extracted from the URL by the paramRoutes
 * mechanism and attached to req.params.name.
 *
 * Returns:
 *   { ok: true, cli: { name, sessionId, status, cwd, startedAt, lastActivity } }
 *   or 404 if not found
 */
export async function handleCliStatus(body, req, res) {
  const name = req.params?.name;

  if (!name || typeof name !== 'string') {
    return json(res, {
      ok: false,
      error: 'CLI name is required',
      code: 'MISSING_PARAM',
    }, 400);
  }

  if (!VALID_CLI_NAMES.includes(name)) {
    return json(res, {
      ok: false,
      error: `Invalid CLI name "${name}". Must be one of: ${VALID_CLI_NAMES.join(', ')}`,
      code: 'INVALID_CLI_NAME',
      validNames: VALID_CLI_NAMES,
    }, 400);
  }

  const cli = getCli(name);

  if (!cli) {
    return json(res, {
      ok: false,
      error: `CLI "${name}" not found. It has not been started yet.`,
      code: 'CLI_NOT_FOUND',
    }, 404);
  }

  return json(res, {
    ok: true,
    cli,
  });
}

// ── GET /cli/list — List all CLI sessions ────────────────────────────

/**
 * List all CLI sessions in the pool.
 *
 * Returns:
 *   { ok: true, clis: [{ name, status, sessionId, lastActivity }, ...] }
 */
export async function handleCliList(body, req, res) {
  const clis = listClis();

  return json(res, {
    ok: true,
    clis,
  });
}
