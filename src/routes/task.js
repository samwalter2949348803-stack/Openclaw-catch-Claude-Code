/**
 * Task route handlers — /task/* and /tasks/* endpoints.
 *
 * Provides the HTTP API for OpenClaw to submit tasks to the Lead Agent,
 * query task status, list tasks, cancel tasks, restart Lead, and query
 * Lead status.
 *
 * Handler signature follows the existing convention: (body, req, res)
 * Zero external dependencies — Node.js built-in APIs only.
 */

import path from 'node:path';
import { json } from '../lib/helpers.js';
import {
  startLeadAgent,
  sendToLead,
  isLeadAlive,
  getLeadStatus,
  restoreLeadAgent,
} from '../lib/lead-agent.js';
import { readTask, listTasks } from '../lib/task-store.js';
import { log } from '../lib/logger.js';

const DEFAULT_CWD = process.env.DEFAULT_CWD || '/root';
const SYSTEM_PROMPT_PATH = path.resolve(process.cwd(), '.agents', 'lead', 'system.md');
const DEFAULT_LEAD_TIMEOUT = parseInt(process.env.LEAD_TIMEOUT || '300', 10) * 1000;

// ── P7-1: Module-level crash info ──────────────────────────────────────

let leadCrashInfo = { crashed: false };

/**
 * Record that the Lead Agent has crashed.
 * Called from the onExit callback when the Lead exits unexpectedly.
 */
function recordCrash(exitCode, signal) {
  leadCrashInfo = {
    crashed: true,
    exitCode: exitCode ?? null,
    signal: signal ?? null,
    timestamp: new Date().toISOString(),
  };
  log('ERROR', 'task', 'Lead Agent crashed — recording crash info', leadCrashInfo);
}

/**
 * Clear the crash info. Called when the Lead Agent is successfully restarted.
 */
function clearCrashInfo() {
  leadCrashInfo = { crashed: false };
}

// ── P6-1: POST /task/submit ─────────────────────────────────────────────

/**
 * Submit a task to the Lead Agent.
 *
 * Request body:
 *   { message: string, cwd?: string, timeout?: number }
 *
 * Flow:
 *   1. Validate input
 *   2. If Lead Agent crashed, return crash error
 *   3. If Lead Agent not alive, start it (lazy initialization)
 *   4. Send the message via sendToLead with timeout protection (P7-3)
 *   5. Return the response
 */
export async function handleTaskSubmit(body, req, res) {
  const { message, cwd, timeout } = body;

  if (!message || typeof message !== 'string') {
    return json(res, {
      ok: false,
      error: 'message is required and must be a string',
      code: 'MISSING_PARAM',
    }, 400);
  }

  // P7-1: If the Lead Agent has crashed, refuse new tasks until restarted
  if (leadCrashInfo.crashed) {
    return json(res, {
      ok: false,
      error: 'Lead Agent crashed',
      code: 'LEAD_CRASHED',
      detail: {
        exitCode: leadCrashInfo.exitCode,
        signal: leadCrashInfo.signal,
        crashedAt: leadCrashInfo.timestamp,
      },
    }, 503);
  }

  const taskCwd = cwd || DEFAULT_CWD;

  // Lazy-initialize Lead Agent if not alive
  if (!isLeadAlive()) {
    log('INFO', 'task', 'Lead Agent not alive, initializing before submit', {
      systemPromptPath: SYSTEM_PROMPT_PATH,
      cwd: taskCwd,
    });

    try {
      await startLeadAgent({
        systemPromptPath: SYSTEM_PROMPT_PATH,
        cwd: taskCwd,
        onExit: (exitCode, signal) => {
          // P7-1: Record crash info on unexpected exit
          log('ERROR', 'task', 'Lead Agent exited unexpectedly', {
            exitCode,
            signal,
          });
          recordCrash(exitCode, signal);
        },
      });
    } catch (err) {
      log('ERROR', 'task', 'Failed to initialize Lead Agent', {
        error: err.message,
      });
      return json(res, {
        ok: false,
        error: `Failed to initialize Lead Agent: ${err.message}`,
        code: 'LEAD_INIT_FAILED',
      }, 500);
    }
  }

  // P7-3: Determine the effective timeout
  const effectiveTimeout = timeout || DEFAULT_LEAD_TIMEOUT;

  // Send message to Lead Agent
  try {
    const result = await sendToLead(message, {
      timeout: effectiveTimeout,
    });

    // Extract a task ID from the response if the Lead Agent included one,
    // otherwise use the session ID as a reference
    const taskId = result.parsed?.taskId
      || result.parsed?.task_id
      || result.sessionId
      || null;

    return json(res, {
      ok: result.ok,
      response: result.response,
      taskId,
      usage: result.usage || null,
    });
  } catch (err) {
    // P7-3: Detect timeout errors specifically
    const isTimeout = err.message?.includes('timed out')
      || err.message?.includes('timeout')
      || err.code === 'TIMEOUT';

    if (isTimeout) {
      log('WARN', 'task', 'sendToLead timed out', {
        timeout: effectiveTimeout,
        error: err.message,
      });
      return json(res, {
        ok: false,
        error: 'Task execution timed out',
        code: 'TIMEOUT',
      }, 504);
    }

    log('ERROR', 'task', 'sendToLead failed during task submit', {
      error: err.message,
    });
    return json(res, {
      ok: false,
      error: err.message,
      code: 'TASK_SUBMIT_FAILED',
    }, 500);
  }
}

// ── P6-2: GET /task/:id/status ──────────────────────────────────────────

/**
 * Get status of a specific task by ID.
 *
 * The task ID is extracted from the URL by the server router and
 * passed via req.params.taskId.
 *
 * Reads .tasks/task_{id}.json and returns its contents.
 */
export async function handleTaskStatus(body, req, res) {
  const taskId = req.params?.taskId;

  if (!taskId) {
    return json(res, {
      ok: false,
      error: 'Task ID is required',
      code: 'MISSING_PARAM',
    }, 400);
  }

  const task = await readTask(taskId);

  if (!task) {
    return json(res, {
      ok: false,
      error: 'Task not found',
      code: 'TASK_NOT_FOUND',
    }, 404);
  }

  return json(res, { ok: true, task });
}

// ── P6-3: GET /tasks/list ───────────────────────────────────────────────

/**
 * List all tasks from the .tasks/ directory.
 *
 * Returns an array of task summaries with id, title, status, assignee, updated.
 */
export async function handleTasksList(body, req, res) {
  try {
    const tasks = await listTasks();
    return json(res, { ok: true, tasks });
  } catch (err) {
    log('ERROR', 'task', 'Failed to list tasks', { error: err.message });
    return json(res, {
      ok: false,
      error: 'Failed to list tasks',
      code: 'TASK_LIST_FAILED',
    }, 500);
  }
}

// ── P6-4: POST /task/:id/cancel ─────────────────────────────────────────

/**
 * Cancel a running task.
 *
 * Currently returns 501 Not Implemented.
 * The Lead Agent operates in CLI-per-message mode (sendToLead completes
 * and the process exits). Killing a running CLI process mid-execution
 * requires more complex process management that will be added in Phase 7.
 */
export async function handleTaskCancel(body, req, res) {
  const taskId = req.params?.taskId;

  if (!taskId) {
    return json(res, {
      ok: false,
      error: 'Task ID is required',
      code: 'MISSING_PARAM',
    }, 400);
  }

  // Log the cancel attempt for observability
  const leadStatus = getLeadStatus();
  log('INFO', 'task', 'Task cancel requested (not yet implemented)', {
    taskId,
    leadRunning: leadStatus.running,
    leadPid: leadStatus.pid,
  });

  return json(res, {
    ok: false,
    error: 'Task cancellation is not yet implemented. Will be available in Phase 7.',
    code: 'NOT_IMPLEMENTED',
    taskId,
  }, 501);
}

// ── P7-2: POST /lead/restart ────────────────────────────────────────────

/**
 * Restart the Lead Agent.
 *
 * Request body:
 *   { sessionId?: string, cwd?: string }
 *
 * If a sessionId is provided, attempts to restore the existing session
 * using restoreLeadAgent(). Otherwise, starts a fresh session via
 * startLeadAgent().
 *
 * Clears any crash info on success.
 */
export async function handleLeadRestart(body, req, res) {
  const { sessionId, cwd } = body;
  const taskCwd = cwd || DEFAULT_CWD;

  log('INFO', 'task', 'Lead Agent restart requested', {
    hasSessionId: !!sessionId,
    cwd: taskCwd,
  });

  // Attempt restoration if a sessionId was provided
  if (sessionId && typeof sessionId === 'string') {
    try {
      const result = restoreLeadAgent(sessionId);
      clearCrashInfo();
      log('INFO', 'task', 'Lead Agent session restored via /lead/restart', {
        sessionId: result.sessionId,
      });
      return json(res, {
        ok: true,
        sessionId: result.sessionId,
        restored: true,
      });
    } catch (err) {
      log('ERROR', 'task', 'Failed to restore Lead Agent session', {
        sessionId,
        error: err.message,
      });
      return json(res, {
        ok: false,
        error: `Failed to restore session: ${err.message}`,
        code: 'LEAD_RESTORE_FAILED',
      }, 500);
    }
  }

  // No sessionId — start a new session
  try {
    const result = await startLeadAgent({
      systemPromptPath: SYSTEM_PROMPT_PATH,
      cwd: taskCwd,
      onExit: (exitCode, signal) => {
        log('ERROR', 'task', 'Lead Agent exited unexpectedly (after restart)', {
          exitCode,
          signal,
        });
        recordCrash(exitCode, signal);
      },
    });

    clearCrashInfo();
    log('INFO', 'task', 'Lead Agent restarted with new session', {
      sessionId: result.sessionId,
    });
    return json(res, {
      ok: true,
      sessionId: result.sessionId,
      restored: false,
    });
  } catch (err) {
    log('ERROR', 'task', 'Failed to start new Lead Agent session', {
      error: err.message,
    });
    return json(res, {
      ok: false,
      error: `Failed to restart Lead Agent: ${err.message}`,
      code: 'LEAD_RESTART_FAILED',
    }, 500);
  }
}

// ── P7-2: GET /lead/status ──────────────────────────────────────────────

/**
 * Get the full Lead Agent status, including crash info if applicable.
 *
 * Returns:
 *   { ok: true, alive: bool, sessionId, startedAt, lastActivity, crashInfo }
 */
export async function handleLeadStatus(body, req, res) {
  const status = getLeadStatus();
  const alive = isLeadAlive();

  return json(res, {
    ok: true,
    alive,
    sessionId: status.sessionId,
    startedAt: status.startedAt,
    lastActivity: status.lastActivity,
    crashInfo: leadCrashInfo.crashed ? {
      exitCode: leadCrashInfo.exitCode,
      signal: leadCrashInfo.signal,
      crashedAt: leadCrashInfo.timestamp,
    } : null,
  });
}
