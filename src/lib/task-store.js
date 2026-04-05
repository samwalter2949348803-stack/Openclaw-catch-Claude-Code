/**
 * Task file read/write utilities.
 *
 * Tasks are stored as JSON files in the .tasks/ directory:
 *   .tasks/task_{id}.json
 *
 * Pure file operations — no Lead Agent interaction.
 * Zero external dependencies — Node.js built-in APIs only.
 */

import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';

const TASKS_DIR = process.env.TASKS_DIR || path.resolve(process.cwd(), '.tasks');

/**
 * Ensure the .tasks/ directory exists.
 */
async function ensureTasksDir() {
  try {
    await mkdir(TASKS_DIR, { recursive: true });
  } catch (err) {
    log('ERROR', 'task-store', 'Failed to create tasks directory', {
      dir: TASKS_DIR,
      error: err.message,
    });
  }
}

/**
 * Read a single task file by ID.
 *
 * @param {string} taskId - The task identifier (without "task_" prefix or ".json" suffix)
 * @returns {Promise<object|null>} Parsed task object, or null if not found
 */
export async function readTask(taskId) {
  const filePath = path.join(TASKS_DIR, `task_${taskId}.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('DEBUG', 'task-store', 'Task file not found', { taskId, filePath });
      return null;
    }
    log('ERROR', 'task-store', 'Failed to read task file', {
      taskId,
      filePath,
      error: err.message,
    });
    return null;
  }
}

/**
 * List all tasks in the .tasks/ directory.
 *
 * Reads every task_*.json file, parses it, and returns an array
 * of summary objects: { id, title, status, assignee, updated }.
 *
 * @returns {Promise<object[]>} Array of task summaries
 */
export async function listTasks() {
  await ensureTasksDir();

  let files;
  try {
    files = await readdir(TASKS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    log('ERROR', 'task-store', 'Failed to read tasks directory', {
      dir: TASKS_DIR,
      error: err.message,
    });
    return [];
  }

  const jsonFiles = files.filter(
    (f) => f.startsWith('task_') && f.endsWith('.json')
  );

  const tasks = [];
  for (const file of jsonFiles) {
    const filePath = path.join(TASKS_DIR, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      tasks.push({
        id: data.id || file.replace(/^task_/, '').replace(/\.json$/, ''),
        title: data.title || null,
        status: data.status || 'unknown',
        assignee: data.assignee || null,
        updated: data.updated || data.updatedAt || null,
      });
    } catch (err) {
      log('WARN', 'task-store', 'Failed to parse task file', {
        file,
        error: err.message,
      });
    }
  }

  return tasks;
}

/**
 * Get the resolved tasks directory path.
 * Useful for callers that need to know where tasks are stored.
 *
 * @returns {string}
 */
export function getTasksDir() {
  return TASKS_DIR;
}
