/**
 * Claude CLI process spawning — runClaude() for request/response,
 * streamClaude() for SSE streaming. Includes concurrency control.
 * Zero external dependencies — Node.js built-in APIs only.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { log } from './logger.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3');
const HEARTBEAT_INTERVAL_MS = 15_000;

let activeProcesses = 0;

/** Get current active process count (for health endpoint). */
export function getActiveProcesses() {
  return activeProcesses;
}

/** Get max concurrent limit (for health endpoint). */
export function getMaxConcurrent() {
  return MAX_CONCURRENT;
}

/**
 * Extract token usage from a parsed Claude CLI result object.
 * Looks in common locations: result.usage, result.result.usage, result.message.usage.
 * Returns { inputTokens, outputTokens } or null if not found.
 */
function extractUsage(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // Try multiple known locations for usage data
  const candidates = [
    parsed.usage,
    parsed.result?.usage,
    parsed.message?.usage,
  ];

  for (const usage of candidates) {
    if (usage && typeof usage === 'object') {
      const inputTokens = usage.input_tokens ?? usage.inputTokens ?? null;
      const outputTokens = usage.output_tokens ?? usage.outputTokens ?? null;
      if (inputTokens !== null || outputTokens !== null) {
        return {
          inputTokens: typeof inputTokens === 'number' ? inputTokens : 0,
          outputTokens: typeof outputTokens === 'number' ? outputTokens : 0,
        };
      }
    }
  }

  return null;
}

/** Spawn claude CLI, return { stdout, stderr, exitCode, parsed, usage }. */
export function runClaude(args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    if (activeProcesses >= MAX_CONCURRENT) {
      return reject(new Error(`Too many concurrent requests (${activeProcesses}/${MAX_CONCURRENT}). Try again later.`));
    }
    activeProcesses++;

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    log('INFO', 'claude-runner', 'Spawning process', { bin: CLAUDE_BIN, args: args.join(' '), cwd, timeout, active: `${activeProcesses}/${MAX_CONCURRENT}` });

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnErr) {
      activeProcesses--;
      log('ERROR', 'claude-runner', 'Failed to spawn process', { bin: CLAUDE_BIN, error: spawnErr.message });
      return reject(new Error(`Failed to spawn claude process: ${spawnErr.message}`));
    }

    log('DEBUG', 'claude-runner', 'Process started', { pid: child.pid });

    let stdout = '', stderr = '', done = false;
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    const finish = () => { if (!done) { done = true; activeProcesses--; } };

    const timer = setTimeout(() => {
      finish();
      child.kill('SIGTERM');
      clearTimeout(timer);
      reject(new Error(`Claude timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', code => {
      finish();
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseErr) {
        if (stdout.trim()) {
          log('WARN', 'claude-runner', 'Failed to parse stdout as JSON', { exitCode: code, preview: stdout.substring(0, 500) });
        }
      }

      // Extract token usage from parsed result
      const usage = extractUsage(parsed);
      if (usage) {
        log('DEBUG', 'claude-runner', 'Token usage extracted', usage);
      }

      resolve({ stdout, stderr, exitCode: code, parsed, usage });
    });

    child.on('error', err => {
      finish();
      clearTimeout(timer);
      log('ERROR', 'claude-runner', 'Child process error', { pid: child.pid, error: err.message });
      reject(new Error(`Claude process error: ${err.message}. Is '${CLAUDE_BIN}' installed and in PATH?`));
    });
  });
}

/** Spawn claude CLI for SSE streaming. onDone is called with { usage } when the stream ends. */
export function streamClaude(args, cwd, timeout, res, onDone) {
  if (activeProcesses >= MAX_CONCURRENT) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `Too many concurrent requests (${activeProcesses}/${MAX_CONCURRENT}). Try again later.` }));
    if (onDone) onDone({ usage: null });
    return;
  }
  activeProcesses++;

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (spawnErr) {
    activeProcesses--;
    log('ERROR', 'claude-runner', 'Failed to spawn stream process', { bin: CLAUDE_BIN, error: spawnErr.message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `Failed to spawn claude process: ${spawnErr.message}` }));
    if (onDone) onDone({ usage: null });
    return;
  }

  const sessionId = randomUUID();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  let streamEnded = false;
  // Track the last result event to extract usage at stream end
  let lastResultObj = null;

  /** Write raw text to the response, guarded by streamEnded flag. */
  const safeWrite = (text) => {
    if (streamEnded) return;
    try {
      res.write(text);
    } catch (writeErr) {
      log('ERROR', 'claude-runner', 'Failed to write to response', { error: writeErr.message });
    }
  };

  const sendSSE = (data) => {
    safeWrite(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sendEventSSE = (event, data) => {
    safeWrite(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sendErrorSSE = (errorMsg, code) => {
    sendEventSSE('error', { error: errorMsg, code: code || 'STREAM_ERROR' });
  };

  // --- Send start event before any data ---
  sendEventSSE('start', { sessionId, timestamp: new Date().toISOString() });

  // --- Heartbeat: keep connection alive through proxies/load balancers ---
  let heartbeatTimer = setInterval(() => {
    safeWrite(':heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text') {
              sendSSE({ type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              sendSSE({ type: 'tool_use', tool: block.name, input: block.input });
            }
          }
        } else if (obj.type === 'result') {
          lastResultObj = obj;
          sendSSE({ type: 'done', session_id: obj.session_id });
        } else if (obj.type === 'tool_result') {
          sendSSE({ type: 'tool_result' });
        } else {
          sendSSE(obj);
        }
      } catch (parseErr) {
        log('WARN', 'claude-runner', 'Failed to parse stream line as JSON', { preview: line.substring(0, 200) });
        if (line.trim()) sendSSE({ type: 'text', text: line });
      }
    }
  });

  let stderrBuf = '';
  child.stderr.on('data', d => stderrBuf += d);

  let streamDone = false;
  const finishStream = (usage) => {
    if (!streamDone) {
      streamDone = true;
      activeProcesses--;
      if (onDone) onDone({ usage: usage || null });
    }
  };

  let timer = setTimeout(() => {
    log('WARN', 'claude-runner', 'Stream timed out', { timeout });
    child.kill('SIGTERM');
    finishStream(null);
    timer = null;
    clearHeartbeat();
    sendErrorSSE(`Timed out after ${timeout}ms`, 'TIMEOUT');
    streamEnded = true;
    res.end();
  }, timeout);

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  child.on('close', code => {
    clearTimer();
    clearHeartbeat();
    let doneSent = false;
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer);
        if (obj.type === 'result') {
          lastResultObj = obj;
          sendSSE({ type: 'done', session_id: obj.session_id });
          doneSent = true;
        } else {
          sendSSE(obj);
        }
      } catch (parseErr) {
        log('WARN', 'claude-runner', 'Failed to parse remaining buffer as JSON', { preview: buffer.substring(0, 200) });
        if (buffer.trim()) sendSSE({ type: 'text', text: buffer });
      }
    }
    if (code !== 0 && stderrBuf) {
      log('ERROR', 'claude-runner', 'Stream process exited with error', { exitCode: code, stderr: stderrBuf.substring(0, 500) });
      sendErrorSSE(stderrBuf.trim(), 'PROCESS_ERROR');
    }
    if (!doneSent) {
      sendSSE({ type: 'done' });
    }
    streamEnded = true;
    res.end();

    // Extract usage from the last result event and pass to onDone
    const usage = extractUsage(lastResultObj);
    if (usage) {
      log('DEBUG', 'claude-runner', 'Stream token usage extracted', usage);
    }
    finishStream(usage);
  });

  child.on('error', err => {
    finishStream(null);
    clearTimer();
    clearHeartbeat();
    log('ERROR', 'claude-runner', 'Stream child process error', { error: err.message });
    sendErrorSSE(err.message, 'SPAWN_ERROR');
    streamEnded = true;
    res.end();
  });

  // If client disconnects, kill child and clean up
  res.on('close', () => {
    if (!streamDone) {
      log('INFO', 'claude-runner', 'Client disconnected, killing child process');
      child.kill('SIGTERM');
    }
    finishStream(null);
    clearTimer();
    clearHeartbeat();
    streamEnded = true;
  });
}
