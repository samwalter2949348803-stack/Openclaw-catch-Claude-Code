/**
 * Structured logger — zero external dependencies.
 * Output: [ISO时间] [LEVEL] [COMPONENT] message {meta}
 * Control minimum level via LOG_LEVEL env var (default: INFO).
 */

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const MIN_LEVEL = LEVELS[
  (process.env.LOG_LEVEL || 'INFO').toUpperCase()
] ?? LEVELS.INFO;

/**
 * Log a structured message.
 * @param {'DEBUG'|'INFO'|'WARN'|'ERROR'} level
 * @param {string} component - source module name
 * @param {string} message
 * @param {object} [meta] - optional metadata object
 */
export function log(level, component, message, meta) {
  const numLevel = LEVELS[level];
  if (numLevel === undefined || numLevel < MIN_LEVEL) return;

  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${level}] [${component}] ${message}`;

  if (meta !== undefined && meta !== null) {
    try {
      line += ' ' + JSON.stringify(meta);
    } catch {
      line += ' [unserializable meta]';
    }
  }

  if (numLevel >= LEVELS.ERROR) {
    console.error(line);
  } else if (numLevel >= LEVELS.WARN) {
    console.warn(line);
  } else {
    console.log(line);
  }
}
