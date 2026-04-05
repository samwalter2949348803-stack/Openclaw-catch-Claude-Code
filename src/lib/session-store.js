/**
 * Session store — in-memory Map backed by JSON file persistence.
 * Also manages per-session locks to serialize concurrent requests.
 * Zero external dependencies — Node.js built-in APIs only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

const SESSION_STORE_PATH = path.join(
  process.env.HOME || '/root', '.claude', 'session-store.json'
);
const SESSION_STORE_TMP = SESSION_STORE_PATH + '.tmp';
const SESSION_STORE_CORRUPTED = SESSION_STORE_PATH + '.corrupted';

// In-memory session store: name -> { sessionId, cwd, created, lastActivity, config, turns }
export const sessions = new Map();

// Per-session lock: name -> Promise (serializes requests to the same session)
export const sessionLocks = new Map();

/** Acquire a per-session lock. Returns a release function. */
export function acquireSessionLock(name) {
  const prev = sessionLocks.get(name) || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  sessionLocks.set(name, next);
  return prev.then(() => release);
}

/** Persist all sessions to disk using atomic write-to-temp-then-rename. */
export function saveSessionStore() {
  try {
    const data = {};
    for (const [name, sess] of sessions) {
      data[name] = sess;
    }
    // Write to temp file first, then rename for atomicity
    fs.writeFileSync(SESSION_STORE_TMP, JSON.stringify(data, null, 2));
    fs.renameSync(SESSION_STORE_TMP, SESSION_STORE_PATH);
  } catch (err) {
    log('ERROR', 'session-store', 'Failed to save sessions', { error: err.message });
    // Clean up temp file if it exists
    try { fs.unlinkSync(SESSION_STORE_TMP); } catch (_) { /* ignore */ }
  }
}

/**
 * Validate a session entry has required fields.
 * Returns true if valid, false otherwise.
 */
function isValidSession(name, sess) {
  if (!sess || typeof sess !== 'object') {
    log('WARN', 'session-store', 'Invalid session skipped: entry is not an object', { key: name });
    return false;
  }
  if (typeof sess.sessionId !== 'string' || sess.sessionId.length === 0) {
    log('WARN', 'session-store', 'Invalid session skipped: sessionId must be a non-empty string', { key: name });
    return false;
  }
  if (typeof sess.cwd !== 'string' || sess.cwd.length === 0) {
    log('WARN', 'session-store', 'Invalid session skipped: cwd must be a non-empty string', { key: name });
    return false;
  }
  return true;
}

/** Load sessions from disk into the in-memory Map. */
export function loadSessionStore() {
  try {
    if (!fs.existsSync(SESSION_STORE_PATH)) return;

    let raw;
    try {
      raw = fs.readFileSync(SESSION_STORE_PATH, 'utf-8');
    } catch (readErr) {
      log('ERROR', 'session-store', 'Failed to read session file', { error: readErr.message });
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      // File is corrupted — backup and start fresh
      log('ERROR', 'session-store', 'Session file corrupted (JSON parse failed)', { error: parseErr.message });
      try {
        fs.copyFileSync(SESSION_STORE_PATH, SESSION_STORE_CORRUPTED);
        log('WARN', 'session-store', 'Corrupted file backed up', { backupPath: SESSION_STORE_CORRUPTED });
      } catch (backupErr) {
        log('ERROR', 'session-store', 'Failed to backup corrupted file', { error: backupErr.message });
      }
      return;
    }

    for (const [name, sess] of Object.entries(data)) {
      if (isValidSession(name, sess)) {
        sessions.set(name, sess);
      }
    }
    log('INFO', 'session-store', `Loaded ${sessions.size} sessions from disk`);
  } catch (err) {
    log('ERROR', 'session-store', 'Failed to load sessions', { error: err.message });
  }
}
