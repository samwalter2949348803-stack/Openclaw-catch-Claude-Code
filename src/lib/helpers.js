/**
 * Utility functions used across routes.
 * Zero external dependencies — Node.js built-in APIs only.
 */

import { log } from './logger.js';

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

/** Send a JSON response with the given status code. */
export function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Parse the JSON body of an incoming request.
 * Returns {} for empty bodies.
 * Throws structured errors for invalid JSON or oversized bodies.
 */
export function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        const err = new Error(`Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes`);
        err.statusCode = 413;
        err.code = 'BODY_TOO_LARGE';
        return reject(err);
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (parseErr) {
        log('WARN', 'helpers', 'Invalid JSON body received', { preview: raw.substring(0, 200) });
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });

    req.on('error', (err) => {
      log('ERROR', 'helpers', 'Request stream error', { error: err.message });
      reject(err);
    });
  });
}

/** Build claude CLI args from a request body. */
export function buildClaudeArgs(body, isStream = false) {
  const args = [];

  if (body.sessionId) {
    args.push('--resume', body.sessionId);
  }

  args.push('-p', body.prompt || body.message || '');

  if (isStream) {
    args.push('--output-format', 'stream-json', '--verbose');
  } else {
    args.push('--output-format', 'json');
  }

  if (body.model) args.push('--model', body.model);
  if (body.permissionMode) args.push('--permission-mode', body.permissionMode);
  if (body.systemPrompt) args.push('--system-prompt', body.systemPrompt);
  if (body.appendSystemPrompt) args.push('--append-system-prompt', body.appendSystemPrompt);
  if (body.maxTurns) args.push('--max-turns', String(body.maxTurns));
  if (body.maxBudgetUsd) args.push('--max-budget-usd', String(body.maxBudgetUsd));
  if (body.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  if (body.forkSession) args.push('--fork-session');
  if (body.customSessionId) args.push('--session-id', body.customSessionId);

  if (body.allowedTools?.length) {
    args.push('--allowed-tools', ...body.allowedTools);
  }
  if (body.disallowedTools?.length) {
    args.push('--disallowed-tools', ...body.disallowedTools);
  }
  if (body.tools?.length) {
    args.push('--tools', ...body.tools);
  }
  if (body.addDir?.length) {
    args.push('--add-dir', ...body.addDir);
  }
  if (body.agents) {
    args.push('--agents', JSON.stringify(body.agents));
  }
  if (body.agent) args.push('--agent', body.agent);
  if (body.baseUrl) args.push('--base-url', body.baseUrl);

  return args;
}
