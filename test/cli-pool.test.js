/**
 * cli-pool.test.js — integration tests for CLI Pool endpoints (/cli/*).
 *
 * Strategy:
 *   1. Spawn src/server.js on a free port, injecting mock-spawn.cjs via
 *      --require so that every CLAUDE_BIN spawn is replaced by fake-claude.js.
 *   2. The project's existing .agents/{general,code,complex}/system.md files
 *      satisfy the system-prompt-path requirement without temp-file setup,
 *      because the server process runs with cwd = project root.
 *   3. Each describe suite that needs state isolation gets its own server
 *      instance so the module-level cli-pool Map starts empty.
 *   4. Pool capacity is controlled via MAX_CLI_POOL env var.
 *
 * Covered scenarios:
 *   1.  GET  /cli/list              — initial empty array
 *   2.  POST /cli/start             — start "general", returns sessionId
 *   3.  GET  /cli/general/status    — status is "idle" after start
 *   4.  POST /cli/start             — invalid name returns 400
 *   5.  GET  /cli/list              — one entry after start
 *   6.  POST /cli/send              — send to existing "general" CLI
 *   7.  POST /cli/send              — lazy-start "code" CLI then send
 *   8.  POST /cli/send              — missing message returns 400
 *   9.  POST /cli/send              — missing name returns 400
 *   10. POST /cli/stop              — stops "general", stopped:true
 *   11. GET  /cli/general/status    — status is "stopped" after stop
 *   12. POST /cli/stop              — nonexistent CLI, stopped:false
 *   13. GET  /cli/nonexistent/status — 404
 *   14. POST /task/submit           — backward-compat still works
 *   15. GET  /lead/status           — backward-compat still works
 *   16. Pool capacity (MAX_CLI_POOL=1) — 2nd start is rejected
 *
 * Zero external dependencies — node:test, node:assert, node:http,
 * node:net, node:child_process, node:path, node:url, node:os.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

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
function request(port, method, pathname, payload = null) {
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
        resolve({ status: res.statusCode, body: parsed });
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
  return request(port, 'GET', `${PREFIX}${route}`, null);
}

// ── Server lifecycle ─────────────────────────────────────────────────────
/**
 * Spawn a server instance on the given port with optional env overrides.
 * Uses mock-spawn.cjs to intercept CLAUDE_BIN so fake-claude.js is used.
 * Returns { port, proc, kill }.
 *
 * NOTE: LOG_LEVEL must remain 'INFO' (or lower) so that the "Server started on"
 * message is emitted and the readiness check in tryResolve() can fire.
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

/* ========================================================================== */
/*  Suite 1 — CLI Pool basic lifecycle (fresh server, isolated state)        */
/* ========================================================================== */

describe('CLI Pool — basic lifecycle', () => {
  let port;
  let kill;

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port);
    kill = srv.kill;
  });

  after(() => {
    kill();
  });

  // ── Scenario 1: GET /cli/list — initial empty array ─────────────────────

  describe('GET /cli/list — initial state', () => {
    test('returns ok:true with an empty clis array', async () => {
      const { status, body } = await get(port, '/cli/list');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.clis), 'clis should be an array');
      assert.strictEqual(body.clis.length, 0, 'pool should be empty on fresh server');
    });
  });

  // ── Scenario 4: POST /cli/start — invalid name returns 400 ──────────────

  describe('POST /cli/start — invalid name', () => {
    test('missing name returns 400 with MISSING_PARAM', async () => {
      const { status, body } = await post(port, '/cli/start', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('numeric name returns 400 with MISSING_PARAM', async () => {
      const { status, body } = await post(port, '/cli/start', { name: 42 });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('non-whitelisted name returns 400 with INVALID_CLI_NAME', async () => {
      const { status, body } = await post(port, '/cli/start', { name: 'invalid' });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'INVALID_CLI_NAME');
    });

    test('error response includes validNames list', async () => {
      const { body } = await post(port, '/cli/start', { name: 'invalid' });
      assert.ok(Array.isArray(body.validNames), 'validNames should be an array');
      assert.ok(body.validNames.includes('general'));
      assert.ok(body.validNames.includes('code'));
      assert.ok(body.validNames.includes('complex'));
    });
  });

  // ── Scenario 2: POST /cli/start — start "general" ───────────────────────

  describe('POST /cli/start — start general CLI', () => {
    test('returns ok:true with name, sessionId, and status', async () => {
      const { status, body } = await post(port, '/cli/start', { name: 'general' });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.name, 'general');
      assert.ok(typeof body.sessionId === 'string', 'sessionId should be a string');
      assert.ok(body.sessionId.length > 0, 'sessionId should be non-empty');
      assert.ok(typeof body.status === 'string', 'status should be a string');
    });

    test('status is idle after start', async () => {
      const { body } = await post(port, '/cli/start', { name: 'general' });
      // Already running → returns existing session with idle status
      assert.strictEqual(body.status, 'idle');
    });
  });

  // ── Scenario 3: GET /cli/:name/status — idle after start ────────────────

  describe('GET /cli/general/status — after start', () => {
    test('returns ok:true with cli.status === idle', async () => {
      const { status, body } = await get(port, '/cli/general/status');
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.ok(body.cli, 'body.cli should be present');
      assert.strictEqual(body.cli.name, 'general');
      assert.strictEqual(body.cli.status, 'idle');
    });

    test('cli object includes sessionId, cwd, startedAt, lastActivity', async () => {
      const { body } = await get(port, '/cli/general/status');
      const { cli } = body;
      assert.ok(typeof cli.sessionId === 'string' && cli.sessionId.length > 0, 'sessionId present');
      assert.ok(typeof cli.cwd === 'string', 'cwd present');
      assert.ok(typeof cli.startedAt === 'string', 'startedAt present');
      assert.ok(typeof cli.lastActivity === 'string', 'lastActivity present');
    });
  });

  // ── Scenario 5: GET /cli/list — one entry after start ───────────────────

  describe('GET /cli/list — after starting general', () => {
    test('returns one CLI entry', async () => {
      const { status, body } = await get(port, '/cli/list');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.clis));
      assert.strictEqual(body.clis.length, 1, 'exactly one CLI in pool');
      assert.strictEqual(body.clis[0].name, 'general');
    });

    test('listed entry has required fields', async () => {
      const { body } = await get(port, '/cli/list');
      const entry = body.clis[0];
      assert.ok('name' in entry);
      assert.ok('status' in entry);
      assert.ok('sessionId' in entry);
      assert.ok('lastActivity' in entry);
    });
  });

  // ── Scenario 13: GET /cli/:name/status — nonexistent ────────────────────

  describe('GET /cli/:name/status — CLI not in pool or invalid', () => {
    test('valid name that has not been started returns 404', async () => {
      // "code" is valid but has not been started in this server instance
      const { status, body } = await get(port, '/cli/code/status');
      assert.strictEqual(status, 404);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'CLI_NOT_FOUND');
    });

    test('invalid CLI name returns 400 with INVALID_CLI_NAME', async () => {
      const { status, body } = await get(port, '/cli/nonexistent/status');
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'INVALID_CLI_NAME');
    });
  });
});

/* ========================================================================== */
/*  Suite 2 — CLI Send (fresh server, isolated state)                        */
/* ========================================================================== */

describe('CLI Pool — send', () => {
  let port;
  let kill;

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port);
    kill = srv.kill;
  });

  after(() => {
    kill();
  });

  // ── Scenario 8 & 9: validation errors ───────────────────────────────────

  describe('POST /cli/send — validation errors', () => {
    test('missing message returns 400 with MISSING_PARAM', async () => {
      const { status, body } = await post(port, '/cli/send', { name: 'general' });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('empty string message returns 400 with MISSING_PARAM', async () => {
      const { status, body } = await post(port, '/cli/send', { name: 'general', message: '' });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('missing name returns 400 with MISSING_PARAM', async () => {
      const { status, body } = await post(port, '/cli/send', { message: 'hello' });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('invalid CLI name returns 400 with INVALID_CLI_NAME', async () => {
      const { status, body } = await post(port, '/cli/send', { name: 'bad-name', message: 'hi' });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'INVALID_CLI_NAME');
    });
  });

  // ── Scenario 7: lazy-start "code" CLI ───────────────────────────────────

  describe('POST /cli/send — lazy-start for "code" CLI', () => {
    test('auto-starts CLI if not running, then returns ok:true + response', async () => {
      const { status, body } = await post(port, '/cli/send', {
        name: 'code',
        message: 'test task',
        timeout: 10000,
      });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.ok(typeof body.response === 'string', 'response should be a string');
      assert.ok(body.response.length > 0, 'response should be non-empty');
      assert.strictEqual(body.name, 'code');
      assert.ok(typeof body.sessionId === 'string');
    });

    test('CLI appears in pool after lazy-start', async () => {
      const { body } = await get(port, '/cli/list');
      const names = body.clis.map((c) => c.name);
      assert.ok(names.includes('code'), 'code should be in the pool after lazy-start');
    });
  });

  // ── Scenario 6: send to already-started CLI ──────────────────────────────

  describe('POST /cli/send — send to existing "code" CLI', () => {
    test('second send to same CLI also returns ok:true', async () => {
      const { status, body } = await post(port, '/cli/send', {
        name: 'code',
        message: 'second message',
        timeout: 10000,
      });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.ok(body.response.length > 0);
    });
  });
});

/* ========================================================================== */
/*  Suite 3 — CLI Stop (fresh server, isolated state)                        */
/* ========================================================================== */

describe('CLI Pool — stop', () => {
  let port;
  let kill;

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port);
    kill = srv.kill;
    // Pre-start "general" so we have something to stop
    await post(port, '/cli/start', { name: 'general' });
  });

  after(() => {
    kill();
  });

  // ── Scenario 10: stop a running CLI ─────────────────────────────────────

  describe('POST /cli/stop — stop general CLI', () => {
    test('returns ok:true and stopped:true', async () => {
      const { status, body } = await post(port, '/cli/stop', { name: 'general' });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.stopped, true);
      assert.strictEqual(body.name, 'general');
    });
  });

  // ── Scenario 11: status is "stopped" after stop ──────────────────────────

  describe('GET /cli/general/status — after stop', () => {
    test('status is stopped after calling /cli/stop', async () => {
      const { status, body } = await get(port, '/cli/general/status');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.cli.status, 'stopped');
    });
  });

  // ── Scenario 12: stop nonexistent CLI ───────────────────────────────────

  describe('POST /cli/stop — nonexistent CLI', () => {
    test('returns ok:true with stopped:false for an unstarted CLI', async () => {
      const { status, body } = await post(port, '/cli/stop', { name: 'complex' });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.stopped, false);
    });
  });

  // ── POST /cli/stop — validation ──────────────────────────────────────────

  describe('POST /cli/stop — validation', () => {
    test('missing name returns 400 with MISSING_PARAM', async () => {
      const { status, body } = await post(port, '/cli/stop', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('invalid CLI name returns 400 with INVALID_CLI_NAME', async () => {
      const { status, body } = await post(port, '/cli/stop', { name: 'unknown' });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'INVALID_CLI_NAME');
    });
  });
});

/* ========================================================================== */
/*  Suite 4 — Backward compatibility (fresh server, isolated state)          */
/* ========================================================================== */

describe('CLI Pool — backward compatibility', () => {
  let port;
  let kill;

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port);
    kill = srv.kill;
  });

  after(() => {
    kill();
  });

  // ── Scenario 14: POST /task/submit still works ───────────────────────────

  describe('POST /task/submit — backward compat', () => {
    test('returns ok:true with response (general CLI auto-initialized)', async () => {
      const { status, body } = await post(port, '/task/submit', {
        message: 'Hello from backward-compat test',
        timeout: 10000,
      });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.ok(typeof body.response === 'string' && body.response.length > 0,
        'response should be a non-empty string');
    });
  });

  // ── Scenario 15: GET /lead/status still works ────────────────────────────

  describe('GET /lead/status — backward compat', () => {
    test('returns ok:true with alive field', async () => {
      const { status, body } = await get(port, '/lead/status');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok('alive' in body, 'body should have alive field');
    });

    test('alive is true after task/submit triggered initialization', async () => {
      const { body } = await get(port, '/lead/status');
      assert.strictEqual(body.alive, true);
    });

    test('sessionId is a non-empty string after initialization', async () => {
      const { body } = await get(port, '/lead/status');
      assert.ok(typeof body.sessionId === 'string' && body.sessionId.length > 0,
        'sessionId should be a non-empty string');
    });
  });
});

/* ========================================================================== */
/*  Suite 5 — Pool capacity enforcement (MAX_CLI_POOL=3)                     */
/* ========================================================================== */

describe('CLI Pool — capacity enforcement (MAX_CLI_POOL=3)', () => {
  let port;
  let kill;

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port, { MAX_CLI_POOL: '3' });
    kill = srv.kill;
  });

  after(() => {
    kill();
  });

  test('starting 3 CLIs (general, code, complex) all succeed', async () => {
    const names = ['general', 'code', 'complex'];
    for (const name of names) {
      const { status, body } = await post(port, '/cli/start', { name });
      assert.strictEqual(
        status, 200,
        `Starting "${name}" failed: status ${status}, body: ${JSON.stringify(body)}`
      );
      assert.strictEqual(body.ok, true, `Expected ok:true for "${name}"`);
    }
  });

  test('pool has exactly 3 entries after starting all 3 CLIs', async () => {
    const { body } = await get(port, '/cli/list');
    assert.strictEqual(body.clis.length, 3, 'Should have exactly 3 CLIs in pool');
  });

  test('re-starting an already-active CLI is idempotent (returns existing session)', async () => {
    // All 3 slots are taken. Re-starting "general" (already active) returns
    // the existing session without consuming an extra slot.
    const { status, body } = await post(port, '/cli/start', { name: 'general' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.status, 'idle');
  });

  test('stopping a CLI and re-starting it succeeds', async () => {
    const stopRes = await post(port, '/cli/stop', { name: 'general' });
    assert.strictEqual(stopRes.status, 200);
    assert.strictEqual(stopRes.body.stopped, true);

    const startRes = await post(port, '/cli/start', { name: 'general' });
    assert.strictEqual(startRes.status, 200,
      `Re-start after stop failed: ${JSON.stringify(startRes.body)}`);
    assert.strictEqual(startRes.body.ok, true);
  });
});

/* ========================================================================== */
/*  Suite 6 — Pool capacity hard limit (MAX_CLI_POOL=1)                      */
/* ========================================================================== */

describe('CLI Pool — hard limit with MAX_CLI_POOL=1', () => {
  let port;
  let kill;

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port, { MAX_CLI_POOL: '1' });
    kill = srv.kill;
  });

  after(() => {
    kill();
  });

  test('starting first CLI (general) succeeds', async () => {
    const { status, body } = await post(port, '/cli/start', { name: 'general' });
    assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.strictEqual(body.ok, true);
  });

  test('starting second CLI (code) when pool is full returns 500 CLI_START_FAILED', async () => {
    const { status, body } = await post(port, '/cli/start', { name: 'code' });
    assert.strictEqual(status, 500);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, 'CLI_START_FAILED');
    assert.ok(
      body.error.includes('full') || body.error.includes('pool'),
      `Error message should mention pool capacity, got: "${body.error}"`
    );
  });

  test('lazy-start via /cli/send also fails when pool is full', async () => {
    // "code" CLI is not running; lazy-start should fail due to pool being full
    const { status, body } = await post(port, '/cli/send', {
      name: 'code',
      message: 'test',
      timeout: 10000,
    });
    assert.strictEqual(status, 500);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, 'CLI_START_FAILED');
  });
});
