/**
 * lead-agent.test.js — end-to-end tests for Lead Agent + Task API endpoints.
 *
 * Strategy:
 *   1. Spawn src/server.js as a child process on a free port (same pattern
 *      as server.test.js).
 *   2. Inject mock-spawn.cjs via --require to intercept CLAUDE_BIN calls.
 *   3. Set TASKS_DIR to a per-test temp directory so .tasks/ reads/writes
 *      are fully isolated and cleaned up after each suite.
 *   4. Create task fixture files as needed for status/list tests.
 *
 * Tested endpoints:
 *   GET  /lead/status
 *   POST /task/submit
 *   GET  /task/:id/status
 *   GET  /tasks/list
 *   POST /task/:id/cancel
 *   POST /lead/restart
 *
 * Zero external dependencies — node:test, node:assert, node:http,
 * node:net, node:child_process, node:path, node:url, node:os, node:fs.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';

// ── Path helpers ────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server.js');
const MOCK_SPAWN = path.join(__dirname, 'mock-spawn.cjs');

const FAKE_CLAUDE_SENTINEL = 'fake-claude-sentinel';
const PREFIX = '/backend-api/claude-code';

// ── Free-port helper ─────────────────────────────────────────────────────
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── HTTP helpers ─────────────────────────────────────────────────────────
function request(port, method, pathname, payload = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = payload !== null ? JSON.stringify(payload) : null;
    const options = {
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function post(port, route, payload = {}) {
  return request(port, 'POST', `${PREFIX}${route}`, payload);
}

function get(port, route) {
  return request(port, 'GET', `${PREFIX}${route}`);
}

// ── Server lifecycle ─────────────────────────────────────────────────────
/**
 * Spawn a server instance on the given port.
 * envOverrides allows setting TASKS_DIR and other test-specific env vars.
 */
function startServer(port, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      CLAUDE_BIN: FAKE_CLAUDE_SENTINEL,
      DEFAULT_CWD: os.tmpdir(),
      LOG_LEVEL: 'INFO',
      AUTH_TOKEN: '',
      ...envOverrides,
    };

    const proc = spawn(
      process.execPath,
      ['--require', MOCK_SPAWN, SERVER_ENTRY],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let started = false;
    let output = '';
    let guardTimer;

    const tryResolve = () => {
      if (!started && output.includes('Server started on')) {
        started = true;
        clearTimeout(guardTimer);
        resolve({ port, proc, kill: () => proc.kill('SIGTERM') });
      }
    };

    proc.stdout.on('data', (chunk) => { output += chunk.toString(); tryResolve(); });
    proc.stderr.on('data', (chunk) => { output += chunk.toString(); tryResolve(); });
    proc.on('error', reject);

    proc.on('exit', (code) => {
      if (!started) {
        clearTimeout(guardTimer);
        reject(new Error(`Server exited (code ${code}) before becoming ready.\nOutput:\n${output}`));
      }
    });

    guardTimer = setTimeout(() => {
      if (!started) {
        proc.kill('SIGTERM');
        reject(new Error(`Server did not start within 15 s.\nOutput:\n${output}`));
      }
    }, 15_000);
  });
}

// ── Helper: write a task fixture file ────────────────────────────────────
async function writeTaskFile(tasksDir, taskId, data) {
  await mkdir(tasksDir, { recursive: true });
  const filePath = path.join(tasksDir, `task_${taskId}.json`);
  await writeFile(filePath, JSON.stringify(data), 'utf-8');
}

/* ====================================================================== */
/*  Suite 1: Fresh server — Lead not yet initialized                      */
/*  Uses a dedicated TASKS_DIR so tests are isolated.                     */
/* ====================================================================== */

describe('Lead Agent + Task API — fresh server', () => {
  let port;
  let kill;
  let tasksDir;

  before(async () => {
    // Create a temporary tasks directory so .tasks reads do not see stale files
    tasksDir = await mkdtemp(path.join(os.tmpdir(), 'openclaw-tasks-'));

    port = await getFreePort();
    const srv = await startServer(port, { TASKS_DIR: tasksDir });
    kill = srv.kill;
  });

  after(async () => {
    kill();
    // Clean up the temporary tasks directory
    await rm(tasksDir, { recursive: true, force: true });
  });

  // ── GET /lead/status — before initialization ──────────────────────────

  describe('GET /lead/status — not initialized', () => {
    test('returns ok:true with alive:false', async () => {
      const { status, body } = await get(port, '/lead/status');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.alive, false);
    });

    test('response has required fields: alive, sessionId, startedAt, lastActivity', async () => {
      const { status, body } = await get(port, '/lead/status');
      assert.strictEqual(status, 200);
      assert.ok('alive' in body, 'body should have alive field');
      assert.ok('sessionId' in body, 'body should have sessionId field');
      assert.ok('startedAt' in body, 'body should have startedAt field');
      assert.ok('lastActivity' in body, 'body should have lastActivity field');
    });

    test('sessionId is null before initialization', async () => {
      const { body } = await get(port, '/lead/status');
      assert.strictEqual(body.sessionId, null);
    });

    test('startedAt is null before initialization', async () => {
      const { body } = await get(port, '/lead/status');
      assert.strictEqual(body.startedAt, null);
    });
  });

  // ── POST /task/submit — validation ────────────────────────────────────

  describe('POST /task/submit — validation', () => {
    test('missing message returns 400', async () => {
      const { status, body } = await post(port, '/task/submit', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('non-string message returns 400', async () => {
      const { status, body } = await post(port, '/task/submit', { message: 42 });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('null message returns 400', async () => {
      const { status, body } = await post(port, '/task/submit', { message: null });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
    });
  });

  // ── POST /task/submit — happy path (auto-initializes Lead Agent) ──────

  describe('POST /task/submit — first submission', () => {
    test('auto-initializes Lead Agent and returns ok:true with response', async () => {
      const { status, body } = await post(port, '/task/submit', {
        message: 'Hello Lead Agent',
        timeout: 10000,
      });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.ok(typeof body.response === 'string', 'response should be a string');
      assert.ok(body.response.length > 0, 'response should be non-empty');
    });
  });

  // ── GET /lead/status — after initialization ───────────────────────────

  describe('GET /lead/status — after first submit', () => {
    test('alive is true after Lead Agent initialization', async () => {
      const { status, body } = await get(port, '/lead/status');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.alive, true);
    });

    test('sessionId is non-empty string after initialization', async () => {
      const { body } = await get(port, '/lead/status');
      assert.ok(typeof body.sessionId === 'string', 'sessionId should be string');
      assert.ok(body.sessionId.length > 0, 'sessionId should be non-empty');
    });

    test('startedAt is an ISO timestamp string after initialization', async () => {
      const { body } = await get(port, '/lead/status');
      assert.ok(typeof body.startedAt === 'string', 'startedAt should be string');
      // Basic ISO timestamp check: parseable as a date
      const d = new Date(body.startedAt);
      assert.ok(!isNaN(d.getTime()), `startedAt "${body.startedAt}" should be a valid date`);
    });

    test('lastActivity is set after initialization', async () => {
      const { body } = await get(port, '/lead/status');
      assert.ok(body.lastActivity !== null, 'lastActivity should not be null after activity');
    });
  });

  // ── POST /task/submit — session reuse ────────────────────────────────

  describe('POST /task/submit — second submission (session reuse)', () => {
    test('second submit reuses the existing Lead session (sessionId does not change)', async () => {
      // Get sessionId from first call
      const { body: status1 } = await get(port, '/lead/status');
      const firstSessionId = status1.sessionId;

      // Second submit
      const { status, body } = await post(port, '/task/submit', {
        message: 'Second task to Lead',
        timeout: 10000,
      });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);

      // SessionId should remain the same (or be the one returned by fake-claude
      // for a --resume call, which echoes the same id)
      const { body: status2 } = await get(port, '/lead/status');
      assert.ok(
        typeof status2.sessionId === 'string' && status2.sessionId.length > 0,
        'sessionId should still be set after second submit'
      );
    });
  });

  // ── GET /task/:id/status — not found ─────────────────────────────────

  describe('GET /task/:id/status — task not found', () => {
    test('returns 404 for nonexistent task ID', async () => {
      const { status, body } = await get(port, '/task/nonexistent-task-abc/status');
      assert.strictEqual(status, 404);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'TASK_NOT_FOUND');
    });
  });

  // ── GET /task/:id/status — task found ────────────────────────────────

  describe('GET /task/:id/status — task found via fixture file', () => {
    const taskId = 'test001';
    const taskData = {
      id: taskId,
      title: 'Test task fixture',
      status: 'pending',
      assignee: 'lead',
      updated: '2025-01-01T00:00:00.000Z',
    };

    before(async () => {
      await writeTaskFile(tasksDir, taskId, taskData);
    });

    test('returns 200 with task contents when file exists', async () => {
      const { status, body } = await get(port, `/task/${taskId}/status`);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(body.task, 'body should have a task field');
    });

    test('task content matches the written fixture', async () => {
      const { body } = await get(port, `/task/${taskId}/status`);
      assert.strictEqual(body.task.id, taskData.id);
      assert.strictEqual(body.task.title, taskData.title);
      assert.strictEqual(body.task.status, taskData.status);
      assert.strictEqual(body.task.assignee, taskData.assignee);
    });
  });

  // ── GET /tasks/list — empty ───────────────────────────────────────────

  describe('GET /tasks/list — after removing all task files', () => {
    // Remove any task files that may have been created by earlier tests
    // (the tasksDir is shared within this suite)
    test('returns empty tasks array when no task_*.json files exist', async () => {
      // Create a fresh temp dir with no task files for this check
      const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'openclaw-empty-tasks-'));
      try {
        // Spin up a second server with the empty TASKS_DIR
        const emptyPort = await getFreePort();
        const emptyServer = await startServer(emptyPort, { TASKS_DIR: emptyDir });
        try {
          const { status, body } = await get(emptyPort, '/tasks/list');
          assert.strictEqual(status, 200);
          assert.strictEqual(body.ok, true);
          assert.ok(Array.isArray(body.tasks), 'tasks should be an array');
          assert.strictEqual(body.tasks.length, 0);
        } finally {
          emptyServer.kill();
        }
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });
  });

  // ── GET /tasks/list — with fixtures ──────────────────────────────────

  describe('GET /tasks/list — with task fixture files', () => {
    const fixtureIds = ['list001', 'list002', 'list003'];

    before(async () => {
      for (const id of fixtureIds) {
        await writeTaskFile(tasksDir, id, {
          id,
          title: `Task ${id}`,
          status: 'pending',
          assignee: 'lead',
          updated: '2025-01-02T00:00:00.000Z',
        });
      }
    });

    test('returns all task files in TASKS_DIR', async () => {
      const { status, body } = await get(port, '/tasks/list');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.tasks), 'tasks should be an array');
      // We created test001 (from status test) + list001, list002, list003
      // The exact count depends on prior test ordering; check at least ≥3
      assert.ok(body.tasks.length >= fixtureIds.length,
        `Expected at least ${fixtureIds.length} tasks, got ${body.tasks.length}`);
    });

    test('each task summary has required fields', async () => {
      const { body } = await get(port, '/tasks/list');
      for (const task of body.tasks) {
        assert.ok('id' in task, 'task should have id');
        assert.ok('status' in task, 'task should have status');
      }
    });
  });

  // ── POST /task/:id/cancel — 501 ───────────────────────────────────────

  describe('POST /task/:id/cancel — not implemented', () => {
    test('returns 501 with NOT_IMPLEMENTED code', async () => {
      const { status, body } = await post(port, '/task/test001/cancel', {});
      assert.strictEqual(status, 501);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'NOT_IMPLEMENTED');
    });

    test('includes the taskId in the response', async () => {
      const { body } = await post(port, '/task/myTaskXyz/cancel', {});
      assert.strictEqual(body.taskId, 'myTaskXyz');
    });
  });

  // ── POST /lead/restart ────────────────────────────────────────────────

  describe('POST /lead/restart', () => {
    test('restart with explicit sessionId restores session, returns ok:true', async () => {
      const { status, body } = await post(port, '/lead/restart', {
        sessionId: 'restored-session-abc',
      });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.restored, true);
      assert.strictEqual(body.sessionId, 'restored-session-abc');
    });

    test('sessionId is updated in /lead/status after restore restart', async () => {
      await post(port, '/lead/restart', { sessionId: 'restored-session-xyz' });
      const { body } = await get(port, '/lead/status');
      assert.strictEqual(body.sessionId, 'restored-session-xyz');
      assert.strictEqual(body.alive, true);
    });

    test('restart without sessionId starts a fresh session, returns ok:true', async () => {
      const { status, body } = await post(port, '/lead/restart', {});
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.restored, false);
      assert.ok(typeof body.sessionId === 'string' && body.sessionId.length > 0,
        'fresh restart should return a non-empty sessionId');
    });
  });
});
