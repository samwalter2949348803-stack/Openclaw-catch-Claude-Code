/**
 * Tool route handlers — /call, /bash, /read, /batch-read, /glob, /grep endpoints.
 * Direct tool execution without going through Claude CLI sessions.
 */

import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { json } from '../lib/helpers.js';
import { log } from '../lib/logger.js';

const DEFAULT_CWD = process.env.DEFAULT_CWD || '/root';
const DEFAULT_TIMEOUT = 120_000;

/* ── Bash security helpers ─────────────────────────────────────────── */

/** Hard-coded blacklist patterns — always blocked regardless of whitelist. */
const BLACKLIST_PATTERNS = [
  'rm -rf /',
  'mkfs',
  'dd if=/dev',
  ':(){ :|:& };:',
];

/**
 * Check whether a command string matches any blacklist pattern.
 * Simple substring match — intentionally not a full shell parser.
 */
function isBlacklisted(command) {
  const normalized = command.trim();
  return BLACKLIST_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Parse the BASH_ALLOWED_COMMANDS env var into a Set (or null if unset).
 * Computed once at module load; restart the process to pick up changes.
 */
function getAllowedCommands() {
  const raw = process.env.BASH_ALLOWED_COMMANDS;
  if (!raw) return null;
  return new Set(raw.split(',').map((c) => c.trim()).filter(Boolean));
}

/**
 * Extract the first token (the executable name) from a command string.
 * Handles common prefixes like env vars (A=B cmd) but keeps it simple.
 */
function extractCommandName(command) {
  const trimmed = command.trim();
  // Skip leading env-var assignments (KEY=VALUE)
  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    // Strip any path prefix (e.g. /usr/bin/git -> git)
    return path.basename(token);
  }
  return tokens[0] || '';
}

/* ── /bash endpoint ────────────────────────────────────────────────── */

/** POST /bash */
export function handleBash(body, req, res) {
  /* 1. BASH_DISABLED gate */
  if (process.env.BASH_DISABLED === 'true') {
    return json(res, { ok: false, error: 'Bash endpoint is disabled', code: 'BASH_DISABLED' }, 403);
  }

  const { command } = body;
  if (!command) return json(res, { ok: false, error: 'command required', code: 'MISSING_PARAM' }, 400);

  /* 2. Hard-coded blacklist */
  if (isBlacklisted(command)) {
    log('WARN', 'tools', 'Bash command blocked by blacklist', { command });
    return json(res, { ok: false, error: 'Command not allowed (blacklisted)', code: 'COMMAND_NOT_ALLOWED' }, 403);
  }

  /* 3. Whitelist check (only when BASH_ALLOWED_COMMANDS is set) */
  const allowed = getAllowedCommands();
  if (allowed) {
    const cmdName = extractCommandName(command);
    if (!allowed.has(cmdName)) {
      log('WARN', 'tools', 'Bash command blocked by whitelist', { command, cmdName });
      return json(res, { ok: false, error: `Command not allowed: ${cmdName}`, code: 'COMMAND_NOT_ALLOWED' }, 403);
    }
  }

  /* 4. Execute with timing & logging */
  const startTime = Date.now();

  return new Promise((resolve) => {
    exec(command, { timeout: DEFAULT_TIMEOUT, cwd: DEFAULT_CWD, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const elapsed = Date.now() - startTime;
      const exitCode = err ? (err.code ?? 1) : 0;

      if (err && !stdout && !stderr) {
        log('WARN', 'tools', 'Bash command failed', { command, elapsed, exitCode, error: err.message });
        json(res, { ok: false, error: err.message, code: 'BASH_EXEC_FAILED' }, 500);
      } else {
        const level = exitCode === 0 ? 'INFO' : 'WARN';
        log(level, 'tools', 'Bash command executed', { command, elapsed, exitCode });
        json(res, { ok: true, result: { stdout: stdout || '', stderr: stderr || '' } });
      }
      resolve();
    });
  });
}

/** POST /read */
export function handleRead(body, req, res) {
  const { file_path } = body;
  if (!file_path) return json(res, { ok: false, error: 'file_path required', code: 'MISSING_PARAM' }, 400);
  try {
    const content = fs.readFileSync(file_path, 'utf-8');
    return json(res, { ok: true, result: { type: 'file', file: { content } } });
  } catch (err) {
    log('ERROR', 'tools', 'Failed to read file', { file: file_path, error: err.message });
    return json(res, { ok: false, error: err.message, code: 'FILE_READ_FAILED' }, 500);
  }
}

/** POST /call — execute a tool directly via shell commands */
export function handleCall(body, req, res) {
  const { tool, args: toolArgs = {} } = body;
  if (!tool) return json(res, { ok: false, error: 'tool required', code: 'MISSING_PARAM' }, 400);

  return new Promise((resolve) => {
    let cmd = '';
    if (tool === 'Glob') {
      let pattern = toolArgs.pattern || '*';
      let dir = toolArgs.path || DEFAULT_CWD;

      if (pattern.includes('**')) {
        const parts = pattern.split('**/');
        const prefix = parts[0];
        const namePart = parts[parts.length - 1];
        if (prefix) {
          dir = path.join(dir, prefix);
        }
        pattern = namePart;
      } else if (pattern.includes('/')) {
        const lastSlash = pattern.lastIndexOf('/');
        dir = path.join(dir, pattern.slice(0, lastSlash));
        pattern = pattern.slice(lastSlash + 1);
      }

      cmd = `find ${JSON.stringify(dir)} -type f -name ${JSON.stringify(pattern)} 2>/dev/null | head -200`;
    } else if (tool === 'Grep') {
      const pattern = toolArgs.pattern || '';
      const dir = toolArgs.path || DEFAULT_CWD;
      const glob = toolArgs.glob ? `--include=${JSON.stringify(toolArgs.glob)}` : '';
      const mode = toolArgs.output_mode === 'content' ? '' : '-l';
      cmd = `grep -r ${mode} ${glob} ${JSON.stringify(pattern)} ${JSON.stringify(dir)} 2>/dev/null | head -200`;
    } else if (tool === 'Read') {
      const fp = toolArgs.file_path;
      if (!fp) { json(res, { ok: false, error: 'file_path required', code: 'MISSING_PARAM' }, 400); return resolve(); }
      try {
        const content = fs.readFileSync(fp, 'utf-8');
        json(res, { ok: true, result: { type: 'file', file: { content } } });
      } catch (err) {
        log('ERROR', 'tools', 'Call/Read failed to read file', { file: fp, error: err.message });
        json(res, { ok: false, error: err.message, code: 'FILE_READ_FAILED' }, 500);
      }
      return resolve();
    } else {
      json(res, { ok: false, error: `Tool '${tool}' not directly supported via /call. Use session-send instead.`, code: 'UNSUPPORTED_TOOL' }, 501);
      return resolve();
    }

    exec(cmd, { timeout: DEFAULT_TIMEOUT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        log('ERROR', 'tools', `Call/${tool} command failed`, { error: err.message });
        json(res, { ok: false, error: err.message, code: 'TOOL_EXEC_FAILED' }, 500);
      } else {
        const lines = stdout.trim() ? stdout.trim().split('\n') : [];
        json(res, { ok: true, result: { filenames: lines, content: stdout } });
      }
      resolve();
    });
  });
}

/** POST /batch-read */
export async function handleBatchRead(body, req, res) {
  const { patterns = [], basePath } = body;
  const base = basePath || DEFAULT_CWD;
  const files = [];

  for (const pattern of patterns) {
    try {
      const result = await new Promise((resolve, reject) => {
        let findDir = base;
        let findName = pattern;

        if (findName.includes('**')) {
          const parts = findName.split('**/');
          const prefix = parts[0];
          findName = parts[parts.length - 1];
          if (prefix) findDir = path.join(findDir, prefix);
        } else if (findName.includes('/')) {
          const lastSlash = findName.lastIndexOf('/');
          findDir = path.join(findDir, findName.slice(0, lastSlash));
          findName = findName.slice(lastSlash + 1);
        }

        exec(`find ${JSON.stringify(findDir)} -type f -name ${JSON.stringify(findName)} 2>/dev/null`,
          { timeout: 10000 }, (err, stdout) => {
            if (err && !stdout) {
              log('WARN', 'tools', 'Batch-read find failed', { pattern, error: err.message });
              return resolve([]);
            }
            resolve(stdout.trim().split('\n').filter(Boolean));
          });
      });
      for (const fp of result) {
        try {
          const content = fs.readFileSync(fp, 'utf-8');
          files.push({ path: fp, content });
        } catch (err) {
          log('WARN', 'tools', 'Batch-read failed to read file', { file: fp, error: err.message });
          files.push({ path: fp, content: '', error: err.message });
        }
      }
    } catch (err) {
      log('ERROR', 'tools', 'Batch-read error processing pattern', { pattern, error: err.message });
      files.push({ path: pattern, content: '', error: err.message });
    }
  }
  return json(res, { ok: true, files });
}
