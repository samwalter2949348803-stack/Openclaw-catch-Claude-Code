/**
 * mock-spawn.cjs — CommonJS pre-load that patches child_process.spawn
 * before any ESM modules are loaded.
 *
 * Load via: node --require ./test/mock-spawn.cjs server.js
 *
 * When CLAUDE_BIN env var matches the spawn cmd, we replace it with
 * `node <FAKE_CLAUDE_JS>` so the real claude binary is never needed.
 */
'use strict';

const cp = require('child_process');
const path = require('path');
const FAKE_CLAUDE_JS = path.join(__dirname, 'fake-claude.js');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const _spawn = cp.spawn.bind(cp);

cp.spawn = function patchedSpawn(cmd, args, opts) {
  const resolvedCmd = path.resolve(process.cwd(), cmd);
  const resolvedBin = path.resolve(process.cwd(), CLAUDE_BIN);
  if (cmd === CLAUDE_BIN || resolvedCmd === resolvedBin) {
    return _spawn(process.execPath, [FAKE_CLAUDE_JS].concat(args || []), opts);
  }
  return _spawn(cmd, args, opts);
};
