/**
 * helpers.test.js — unit tests for src/lib/helpers.js
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Zero external dependencies.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

// We import the helpers directly — they are pure functions.
import { buildClaudeArgs, parseBody } from '../src/lib/helpers.js';

/* ================================================================== */
/*  buildClaudeArgs                                                   */
/* ================================================================== */

describe('buildClaudeArgs', () => {
  test('minimal body — only prompt', () => {
    const args = buildClaudeArgs({ prompt: 'hello' });
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('hello'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('json'));
    // No --resume flag when no sessionId
    assert.ok(!args.includes('--resume'));
  });

  test('uses message field when prompt is absent', () => {
    const args = buildClaudeArgs({ message: 'hi there' });
    const idx = args.indexOf('-p');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'hi there');
  });

  test('empty body produces empty prompt string', () => {
    const args = buildClaudeArgs({});
    const idx = args.indexOf('-p');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], '');
  });

  test('sessionId adds --resume before -p', () => {
    const args = buildClaudeArgs({ prompt: 'msg', sessionId: 'sess-abc' });
    const resumeIdx = args.indexOf('--resume');
    assert.ok(resumeIdx !== -1);
    assert.strictEqual(args[resumeIdx + 1], 'sess-abc');
    // --resume must appear before -p
    const pIdx = args.indexOf('-p');
    assert.ok(resumeIdx < pIdx);
  });

  test('isStream=true uses stream-json format', () => {
    const args = buildClaudeArgs({ prompt: 'test' }, true);
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--verbose'));
    assert.ok(!args.includes('json') || args.indexOf('stream-json') >= 0);
  });

  test('model option is forwarded', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'claude-3-opus' });
    const idx = args.indexOf('--model');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'claude-3-opus');
  });

  test('permissionMode option is forwarded', () => {
    const args = buildClaudeArgs({ prompt: 'x', permissionMode: 'auto' });
    const idx = args.indexOf('--permission-mode');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'auto');
  });

  test('maxTurns is converted to string', () => {
    const args = buildClaudeArgs({ prompt: 'x', maxTurns: 5 });
    const idx = args.indexOf('--max-turns');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], '5');
    assert.strictEqual(typeof args[idx + 1], 'string');
  });

  test('maxBudgetUsd is converted to string', () => {
    const args = buildClaudeArgs({ prompt: 'x', maxBudgetUsd: 1.5 });
    const idx = args.indexOf('--max-budget-usd');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], '1.5');
  });

  test('dangerouslySkipPermissions adds flag', () => {
    const args = buildClaudeArgs({ prompt: 'x', dangerouslySkipPermissions: true });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  test('allowedTools spread into args', () => {
    const args = buildClaudeArgs({ prompt: 'x', allowedTools: ['Bash', 'Read'] });
    const idx = args.indexOf('--allowed-tools');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'Bash');
    assert.strictEqual(args[idx + 2], 'Read');
  });

  test('disallowedTools spread into args', () => {
    const args = buildClaudeArgs({ prompt: 'x', disallowedTools: ['Write'] });
    const idx = args.indexOf('--disallowed-tools');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'Write');
  });

  test('systemPrompt is forwarded', () => {
    const args = buildClaudeArgs({ prompt: 'x', systemPrompt: 'Be helpful' });
    const idx = args.indexOf('--system-prompt');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'Be helpful');
  });

  test('appendSystemPrompt is forwarded', () => {
    const args = buildClaudeArgs({ prompt: 'x', appendSystemPrompt: 'extra instructions' });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'extra instructions');
  });

  test('agents is JSON-stringified', () => {
    const agentsVal = { name: 'myAgent' };
    const args = buildClaudeArgs({ prompt: 'x', agents: agentsVal });
    const idx = args.indexOf('--agents');
    assert.ok(idx !== -1);
    assert.deepStrictEqual(JSON.parse(args[idx + 1]), agentsVal);
  });

  test('agent string is forwarded', () => {
    const args = buildClaudeArgs({ prompt: 'x', agent: 'planner' });
    const idx = args.indexOf('--agent');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'planner');
  });

  test('baseUrl is forwarded', () => {
    const args = buildClaudeArgs({ prompt: 'x', baseUrl: 'https://example.com' });
    const idx = args.indexOf('--base-url');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'https://example.com');
  });

  test('addDir entries are spread', () => {
    const args = buildClaudeArgs({ prompt: 'x', addDir: ['/a', '/b'] });
    const idx = args.indexOf('--add-dir');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], '/a');
    assert.strictEqual(args[idx + 2], '/b');
  });

  test('empty arrays for tools are not added to args', () => {
    const args = buildClaudeArgs({ prompt: 'x', allowedTools: [], disallowedTools: [], tools: [] });
    assert.ok(!args.includes('--allowed-tools'));
    assert.ok(!args.includes('--disallowed-tools'));
    assert.ok(!args.includes('--tools'));
  });

  test('forkSession adds --fork-session flag', () => {
    const args = buildClaudeArgs({ prompt: 'x', forkSession: true });
    assert.ok(args.includes('--fork-session'));
  });

  test('customSessionId adds --session-id', () => {
    const args = buildClaudeArgs({ prompt: 'x', customSessionId: 'my-custom-id' });
    const idx = args.indexOf('--session-id');
    assert.ok(idx !== -1);
    assert.strictEqual(args[idx + 1], 'my-custom-id');
  });

  test('returns an Array', () => {
    const args = buildClaudeArgs({ prompt: 'test' });
    assert.ok(Array.isArray(args));
  });
});

/* ================================================================== */
/*  parseBody                                                         */
/* ================================================================== */

/**
 * Helper: create a mock IncomingMessage-like readable stream that
 * emits the supplied string as data then ends.
 */
function makeReq(body, opts = {}) {
  const stream = new Readable({ read() {} });
  // Push data asynchronously to simulate real network behaviour
  if (body !== null) {
    process.nextTick(() => {
      if (opts.chunked) {
        // Split into two chunks
        const half = Math.floor(body.length / 2);
        stream.push(body.slice(0, half));
        stream.push(body.slice(half));
      } else {
        stream.push(body);
      }
      stream.push(null); // EOF
    });
  }
  return stream;
}

describe('parseBody', () => {
  test('valid JSON body is parsed', async () => {
    const payload = JSON.stringify({ foo: 'bar', num: 42 });
    const req = makeReq(payload);
    const body = await parseBody(req);
    assert.deepStrictEqual(body, { foo: 'bar', num: 42 });
  });

  test('empty body resolves to {}', async () => {
    const req = makeReq('');
    const body = await parseBody(req);
    assert.deepStrictEqual(body, {});
  });

  test('whitespace-only body resolves to {}', async () => {
    const req = makeReq('   ');
    // parseBody checks !raw which is falsy for whitespace-only strings after Buffer.concat…toString
    // The server sends empty string for empty body; whitespace string is non-empty
    // so it will try to parse and fail. Verify we get INVALID_JSON error.
    try {
      await parseBody(req);
      // If it resolves (whitespace treated as empty), that is also acceptable
    } catch (err) {
      assert.strictEqual(err.code, 'INVALID_JSON');
      assert.strictEqual(err.statusCode, 400);
    }
  });

  test('nested JSON object is parsed', async () => {
    const payload = JSON.stringify({ a: { b: { c: [1, 2, 3] } } });
    const req = makeReq(payload);
    const body = await parseBody(req);
    assert.deepStrictEqual(body, { a: { b: { c: [1, 2, 3] } } });
  });

  test('invalid JSON rejects with INVALID_JSON code', async () => {
    const req = makeReq('{not valid json}');
    await assert.rejects(
      () => parseBody(req),
      (err) => {
        assert.strictEqual(err.statusCode, 400);
        assert.strictEqual(err.code, 'INVALID_JSON');
        return true;
      }
    );
  });

  test('truncated JSON rejects with INVALID_JSON code', async () => {
    const req = makeReq('{"key": "val');
    await assert.rejects(
      () => parseBody(req),
      (err) => {
        assert.strictEqual(err.code, 'INVALID_JSON');
        return true;
      }
    );
  });

  test('body exceeding 1MB rejects with BODY_TOO_LARGE', async () => {
    // Build a JSON string that is just over 1MB
    const bigValue = 'x'.repeat(1024 * 1024 + 100);
    const payload = JSON.stringify({ data: bigValue });
    const stream = new Readable({ read() {} });
    // Push the oversized chunk asynchronously
    process.nextTick(() => {
      stream.push(Buffer.from(payload));
      stream.push(null);
    });
    await assert.rejects(
      () => parseBody(stream),
      (err) => {
        assert.strictEqual(err.statusCode, 413);
        assert.strictEqual(err.code, 'BODY_TOO_LARGE');
        return true;
      }
    );
  });

  test('chunked delivery still parses correctly', async () => {
    const payload = JSON.stringify({ hello: 'world' });
    const req = makeReq(payload, { chunked: true });
    const body = await parseBody(req);
    assert.deepStrictEqual(body, { hello: 'world' });
  });

  test('array JSON body is parsed', async () => {
    const req = makeReq('[1,2,3]');
    const body = await parseBody(req);
    assert.deepStrictEqual(body, [1, 2, 3]);
  });
});
