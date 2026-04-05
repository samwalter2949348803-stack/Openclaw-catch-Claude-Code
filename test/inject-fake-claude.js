/**
 * inject-fake-claude.js — ESM loader hook for tests.
 *
 * Loaded via --import flag when spawning the test server.
 * Intercepts the `node:child_process` module so that any
 * spawn() call targeting CLAUDE_BIN is replaced with a direct
 * invocation of fake-claude.js via process.execPath (node).
 *
 * This makes the tests work cross-platform (Linux, macOS, Windows)
 * without requiring the shell to interpret .sh files.
 *
 * Mechanism: we patch process.env.CLAUDE_BIN to be process.execPath
 * and set FAKE_CLAUDE_SCRIPT so the real module loader picks it up,
 * but we also need claude-runner.js to prepend the script path.
 *
 * Simpler alternative used here: register a global that overrides spawn
 * before any module runs.
 */

// This file is loaded before any application modules.
// We replace the spawn function globally so claude-runner.js picks it up.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import childProcess from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_JS = path.join(__dirname, 'fake-claude.js');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Intercept: wrap spawn so that when CLAUDE_BIN is called, we substitute
// `node <fake-claude.js> <original args>` instead.
const originalSpawn = childProcess.spawn.bind(childProcess);

function patchedSpawn(cmd, args, opts) {
  if (cmd === CLAUDE_BIN || cmd === path.resolve(CLAUDE_BIN)) {
    // Replace with: node fake-claude.js <args>
    return originalSpawn(process.execPath, [FAKE_CLAUDE_JS, ...(args || [])], opts);
  }
  return originalSpawn(cmd, args, opts);
}

// Overwrite the exported spawn on the module object.
// ESM modules cache the live binding, so we need to overwrite the property
// on the module namespace object that child_process exposes.
Object.defineProperty(childProcess, 'spawn', {
  value: patchedSpawn,
  writable: true,
  configurable: true,
});
