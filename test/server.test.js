/**
 * server.test.js — integration tests for the HTTP server.
 *
 * Strategy:
 *   1. Spawn src/server.js as a child process with:
 *      - PORT=<free port>  (resolved via net.createServer trick)
 *      - CLAUDE_BIN=fake-claude-sentinel (intercepted by mock-spawn.cjs)
 *      - DEFAULT_CWD=<tmp dir>
 *      - --require ./test/mock-spawn.cjs  (patches child_process.spawn)
 *   2. mock-spawn.cjs replaces any spawn of CLAUDE_BIN with
 *      `node fake-claude.js <original args>` — works cross-platform.
 *   3. Wait for "Server started" in stdout/stderr, then run assertions.
 *   4. Kill server in after().
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

// ── Path helpers ────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server.js');
const MOCK_SPAWN = path.join(__dirname, 'mock-spawn.cjs');

// Sentinel value — mock-spawn.cjs intercepts any spawn with this name
// and replaces it with `node fake-claude.js <args>`.
const FAKE_CLAUDE_SENTINEL = 'fake-claude-sentinel';

const PREFIX = '/backend-api/claude-code';
const TMP_CWD = os.tmpdir();

// ── Free-port helper ────────────────────────────────────────────────

/**
 * Ask the OS for a free TCP port by binding to port 0, reading the
 * assigned port, then immediately releasing the socket.
 */
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

// ── HTTP helper ─────────────────────────────────────────────────────

/**
 * Make an HTTP request and return { status, body (parsed JSON), headers }.
 */
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

/** Convenience: POST to a prefixed route. */
function post(port, route, payload, headers) {
  return request(port, 'POST', `${PREFIX}${route}`, payload, headers);
}

/** Convenience: GET from a prefixed route. */
function get(port, route, headers) {
  return request(port, 'GET', `${PREFIX}${route}`, null, headers);
}

// ── Server lifecycle ────────────────────────────────────────────────

/**
 * Start a server instance on the given port with optional env overrides.
 *
 * The server is spawned with --require ./test/mock-spawn.cjs which
 * intercepts child_process.spawn calls so that CLAUDE_BIN is replaced
 * by `node fake-claude.js`.  This works on all platforms without
 * requiring a shell-executable .sh script.
 *
 * Returns { port, proc, kill }.
 */
function startServer(port, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      CLAUDE_BIN: FAKE_CLAUDE_SENTINEL,
      DEFAULT_CWD: TMP_CWD,
      LOG_LEVEL: 'INFO',
      AUTH_TOKEN: '',       // prevent inheriting from parent env
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

    // Guard: fail if server doesn't start within 15 s
    guardTimer = setTimeout(() => {
      if (!started) {
        proc.kill('SIGTERM');
        reject(new Error(`Server did not start within 15 s.\nOutput:\n${output}`));
      }
    }, 15_000);
  });
}

/* ================================================================== */
/*  Test suite — default server (no auth)                            */
/* ================================================================== */

describe('HTTP Server integration', () => {
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

  // ── Health check ──────────────────────────────────────────────────

  describe('GET /health', () => {
    test('returns 200 with ok:true', async () => {
      const { status, body } = await request(port, 'GET', '/health');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(typeof body.uptime === 'number');
      assert.ok(typeof body.activeSessions === 'number');
    });
  });

  // ── CORS preflight ────────────────────────────────────────────────

  describe('OPTIONS preflight', () => {
    test('returns 204', async () => {
      const { status } = await request(port, 'OPTIONS', `${PREFIX}/session/list`);
      assert.strictEqual(status, 204);
    });
  });

  // ── Invalid prefix ────────────────────────────────────────────────

  describe('invalid prefix', () => {
    test('returns 404 when prefix is missing', async () => {
      const { status, body } = await request(port, 'GET', '/wrong/path');
      assert.strictEqual(status, 404);
      assert.strictEqual(body.ok, false);
    });
  });

  // ── Unknown route ─────────────────────────────────────────────────

  describe('unknown route', () => {
    test('returns 404 for a route that does not exist', async () => {
      const { status, body } = await post(port, '/does-not-exist', {});
      assert.strictEqual(status, 404);
      assert.strictEqual(body.ok, false);
    });
  });

  // ── /connect ──────────────────────────────────────────────────────

  describe('POST /connect', () => {
    test('returns ok:true', async () => {
      const { status, body } = await post(port, '/connect', {});
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(typeof body.tools === 'number');
    });
  });

  // ── /disconnect ───────────────────────────────────────────────────

  describe('POST /disconnect', () => {
    test('returns ok:true', async () => {
      const { status, body } = await post(port, '/disconnect', {});
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
    });
  });

  // ── GET /tools ────────────────────────────────────────────────────

  describe('GET /tools', () => {
    test('returns ok:true with tools array', async () => {
      const { status, body } = await get(port, '/tools');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.tools));
      assert.ok(body.tools.length > 0);
    });
  });

  // ── /session/list ─────────────────────────────────────────────────

  describe('GET /session/list', () => {
    test('returns ok:true with sessions array', async () => {
      const { status, body } = await get(port, '/session/list');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.sessions));
    });
  });

  // ── /session/start ────────────────────────────────────────────────

  describe('POST /session/start', () => {
    test('missing name returns 400', async () => {
      const { status, body } = await post(port, '/session/start', { cwd: TMP_CWD });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('valid name starts a session and returns claudeSessionId', async () => {
      const { status, body } = await post(port, '/session/start', {
        name: 'test-session-start',
        cwd: TMP_CWD,
        timeout: 8000,
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(typeof body.claudeSessionId === 'string');
      assert.ok(body.claudeSessionId.length > 0);
    });
  });

  // ── /session/status ───────────────────────────────────────────────

  describe('POST /session/status', () => {
    test('missing name returns 400', async () => {
      const { status, body } = await post(port, '/session/status', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
    });

    test('non-existent session returns 404', async () => {
      const { status, body } = await post(port, '/session/status', { name: 'no-such-session' });
      assert.strictEqual(status, 404);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'SESSION_NOT_FOUND');
    });

    test('existing session returns stats', async () => {
      // Start a session first
      const startRes = await post(port, '/session/start', {
        name: 'test-session-status',
        cwd: TMP_CWD,
        timeout: 8000,
      });
      assert.strictEqual(startRes.status, 200, `session/start failed: ${JSON.stringify(startRes.body)}`);

      const { status, body } = await post(port, '/session/status', { name: 'test-session-status' });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(typeof body.stats === 'object');
      assert.ok(typeof body.stats.turns === 'number');
      assert.ok(typeof body.stats.uptime === 'number');
    });
  });

  // ── /session/stop ─────────────────────────────────────────────────

  describe('POST /session/stop', () => {
    test('missing name returns 400', async () => {
      const { status, body } = await post(port, '/session/stop', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('stops an existing session', async () => {
      // Start session
      await post(port, '/session/start', {
        name: 'test-session-stop',
        cwd: TMP_CWD,
        timeout: 8000,
      });

      // Stop it
      const { status, body } = await post(port, '/session/stop', { name: 'test-session-stop' });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);

      // Verify it's gone
      const { status: s2, body: b2 } = await post(port, '/session/status', { name: 'test-session-stop' });
      assert.strictEqual(s2, 404);
      assert.strictEqual(b2.code, 'SESSION_NOT_FOUND');
    });

    test('stopping a non-existent session still returns ok:true', async () => {
      // Idempotent delete
      const { status, body } = await post(port, '/session/stop', { name: 'ghost-session' });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
    });
  });

  // ── 501 stub endpoints ────────────────────────────────────────────

  describe('501 stub endpoints', () => {
    const stubs = [
      '/session/pause',
      '/session/resume',
      '/session/fork',
      '/session/search',
    ];

    for (const route of stubs) {
      test(`POST ${route} returns 501`, async () => {
        const { status, body } = await post(port, route, { name: 'x' });
        assert.strictEqual(status, 501);
        assert.strictEqual(body.ok, false);
        assert.strictEqual(body.code, 'NOT_IMPLEMENTED');
      });
    }
  });

  // ── /bash ─────────────────────────────────────────────────────────

  describe('POST /bash', () => {
    test('missing command returns 400', async () => {
      const { status, body } = await post(port, '/bash', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('echo command returns stdout', async () => {
      const { status, body } = await post(port, '/bash', { command: 'echo hello' });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(body.result.stdout.trim().includes('hello'));
    });

    test('blacklisted rm -rf / is blocked', async () => {
      const { status, body } = await post(port, '/bash', { command: 'rm -rf /' });
      assert.strictEqual(status, 403);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'COMMAND_NOT_ALLOWED');
    });

    test('blacklisted mkfs command is blocked', async () => {
      const { status, body } = await post(port, '/bash', { command: 'mkfs /dev/sda' });
      assert.strictEqual(status, 403);
      assert.strictEqual(body.ok, false);
    });
  });

  // ── /read ─────────────────────────────────────────────────────────

  describe('POST /read', () => {
    test('missing file_path returns 400', async () => {
      const { status, body } = await post(port, '/read', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('reads an existing file', async () => {
      const { status, body } = await post(port, '/read', {
        file_path: path.join(ROOT, 'package.json'),
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(typeof body.result.file.content === 'string');
      assert.ok(body.result.file.content.includes('openclaw'));
    });

    test('non-existent file returns 500 with FILE_READ_FAILED', async () => {
      const { status, body } = await post(port, '/read', {
        file_path: path.join(TMP_CWD, 'does-not-exist-abc123.txt'),
      });
      assert.strictEqual(status, 500);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'FILE_READ_FAILED');
    });
  });

  // ── /session/history ─────────────────────────────────────────────

  describe('POST /session/history', () => {
    test('returns empty history when no JSONL file exists', async () => {
      // Start a session backed by fake-claude → session ID = fake-session-123
      await post(port, '/session/start', {
        name: 'test-history-session',
        cwd: TMP_CWD,
        timeout: 8000,
      });

      const { status, body } = await post(port, '/session/history', {
        name: 'test-history-session',
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(Array.isArray(body.history));
      assert.strictEqual(body.count, 0);
    });

    test('missing name returns 400', async () => {
      const { status, body } = await post(port, '/session/history', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
    });

    test('non-existent session returns 404', async () => {
      const { status, body } = await post(port, '/session/history', { name: 'no-session' });
      assert.strictEqual(status, 404);
      assert.strictEqual(body.ok, false);
    });
  });

  // ── /call ─────────────────────────────────────────────────────────

  describe('POST /call', () => {
    test('missing tool returns 400', async () => {
      const { status, body } = await post(port, '/call', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
    });

    test('unsupported tool returns 501', async () => {
      const { status, body } = await post(port, '/call', { tool: 'NonExistentTool' });
      assert.strictEqual(status, 501);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'UNSUPPORTED_TOOL');
    });
  });

  // ── /resume ───────────────────────────────────────────────────────

  describe('POST /resume', () => {
    test('missing sessionId and prompt returns 400', async () => {
      const { status, body } = await post(port, '/resume', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.code, 'MISSING_PARAM');
    });

    test('missing prompt returns 400', async () => {
      const { status, body } = await post(port, '/resume', { sessionId: 'some-id' });
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
    });

    test('valid sessionId + prompt calls fake-claude and returns output', async () => {
      const { status, body } = await post(port, '/resume', {
        sessionId: 'fake-session-123',
        prompt: 'say hello',
        cwd: TMP_CWD,
        timeout: 8000,
      });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
      assert.ok(body.output !== undefined);
    });
  });

  // ── /continue ─────────────────────────────────────────────────────

  describe('POST /continue', () => {
    test('missing prompt returns 400', async () => {
      const { status, body } = await post(port, '/continue', {});
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
    });

    test('valid prompt calls fake-claude and returns output', async () => {
      const { status, body } = await post(port, '/continue', {
        prompt: 'continue from here',
        cwd: TMP_CWD,
        timeout: 8000,
      });
      assert.strictEqual(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      assert.strictEqual(body.ok, true);
    });
  });
});

/* ================================================================== */
/*  Auth tests — separate server instance with AUTH_TOKEN set        */
/* ================================================================== */

describe('Auth enforcement (AUTH_TOKEN)', () => {
  let port;
  let kill;
  const TOKEN = 'test-secret-token-xyz';

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port, { AUTH_TOKEN: TOKEN });
    kill = srv.kill;
  });

  after(() => {
    kill();
  });

  test('/health is reachable without token (no prefix, no auth)', async () => {
    const { status, body } = await request(port, 'GET', '/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });

  test('request without Authorization header returns 401', async () => {
    const { status, body } = await get(port, '/session/list');
    assert.strictEqual(status, 401);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, 'UNAUTHORIZED');
  });

  test('request with wrong token returns 401', async () => {
    const { status, body } = await get(port, '/session/list', {
      Authorization: 'Bearer wrong-token',
    });
    assert.strictEqual(status, 401);
    assert.strictEqual(body.ok, false);
  });

  test('request with correct token succeeds', async () => {
    const { status, body } = await get(port, '/session/list', {
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });
});

/* ================================================================== */
/*  BASH_DISABLED tests                                              */
/* ================================================================== */

describe('BASH_DISABLED gate', () => {
  let port;
  let kill;

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port, { BASH_DISABLED: 'true' });
    kill = srv.kill;
  });

  after(() => {
    kill();
  });

  test('/bash returns 403 when BASH_DISABLED=true', async () => {
    const { status, body } = await post(port, '/bash', { command: 'echo hello' });
    assert.strictEqual(status, 403);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, 'BASH_DISABLED');
  });
});

/* ================================================================== */
/*  BASH_ALLOWED_COMMANDS whitelist                                  */
/* ================================================================== */

describe('BASH_ALLOWED_COMMANDS whitelist', () => {
  let port;
  let kill;

  before(async () => {
    port = await getFreePort();
    const srv = await startServer(port, { BASH_ALLOWED_COMMANDS: 'echo,ls' });
    kill = srv.kill;
  });

  after(() => {
    kill();
  });

  test('allowed command (echo) executes successfully', async () => {
    const { status, body } = await post(port, '/bash', { command: 'echo test' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
  });

  test('non-whitelisted command is blocked with COMMAND_NOT_ALLOWED', async () => {
    const { status, body } = await post(port, '/bash', { command: 'cat /etc/passwd' });
    assert.strictEqual(status, 403);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, 'COMMAND_NOT_ALLOWED');
  });
});
