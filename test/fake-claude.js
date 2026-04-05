#!/usr/bin/env node
/**
 * fake-claude.js — cross-platform mock for the claude CLI.
 *
 * Parses the same arguments that claude-runner.js passes, and
 * emits a minimal valid JSON response so the real claude binary
 * is never required during tests.
 *
 * Supports:
 *   --output-format json            → single-line JSON result
 *   --output-format stream-json     → newline-delimited JSON (SSE source)
 *   --resume <id>                   → echoes that session ID back
 *   -p <prompt>                     → ignored (mock always succeeds)
 *   --continue                      → treated like a new session
 *   all other flags                 → silently ignored
 */

const args = process.argv.slice(2);

let isStream = false;
let resumeId = '';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--output-format' && args[i + 1]) {
    if (args[i + 1] === 'stream-json') isStream = true;
    i++;
  } else if (arg === '--resume' && args[i + 1]) {
    resumeId = args[i + 1];
    i++;
  }
}

// When resuming, echo the same session ID so the server can track it.
const sessionId = resumeId || 'fake-session-123';

if (isStream) {
  // stream-json mode: emit newline-delimited JSON objects
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from fake claude' }],
    },
  }) + '\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Hello from fake claude',
    session_id: sessionId,
    is_error: false,
  }) + '\n');
} else {
  // json mode: single JSON object
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Hello from fake claude',
    session_id: sessionId,
    is_error: false,
  }) + '\n');
}

process.exit(0);
