/**
 * Task file read/write utilities.
 *
 * Each CLI agent stores tasks in its own workspace:
 *   .cli-workspaces/{agent}/.tasks/task_{id}.json
 *
 * readTask and listTasks scan all agent workspaces.
 * Pure file operations — no CLI interaction.
 * Zero external dependencies — Node.js built-in APIs only.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';

const CLI_WORKSPACES_DIR = process.env.CLI_WORKSPACES_DIR || path.resolve(process.cwd(), '.cli-workspaces');
const LEGACY_TASKS_DIR = process.env.TASKS_DIR || null;
const AGENT_NAMES = ['general', 'code', 'complex'];

/**
 * Get all .tasks/ directories across agent workspaces.
 * Also includes legacy TASKS_DIR if set (backward compat for tests).
 * @returns {string[]}
 */
function getTasksDirs() {
  const dirs = AGENT_NAMES.map((name) => path.join(CLI_WORKSPACES_DIR, name, '.tasks'));
  if (LEGACY_TASKS_DIR) {
    dirs.push(LEGACY_TASKS_DIR);
  }
  return dirs;
}

/**
 * Read a single task file by ID.
 * Searches all agent workspaces.
 *
 * @param {string} taskId - The task identifier (without "task_" prefix or ".json" suffix)
 * @returns {Promise<object|null>} Parsed task object, or null if not found
 */
export async function readTask(taskId) {
  for (const dir of getTasksDirs()) {
    const filePath = path.join(dir, `task_${taskId}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log('ERROR', 'task-store', 'Failed to read task file', {
          taskId,
          filePath,
          error: err.message,
        });
      }
    }
  }
  log('DEBUG', 'task-store', 'Task file not found in any workspace', { taskId });
  return null;
}

/**
 * List all tasks across all agent workspaces.
 *
 * @returns {Promise<object[]>} Array of task summaries
 */
export async function listTasks() {
  const tasks = [];

  for (const dir of getTasksDirs()) {
    const agentName = path.basename(path.dirname(dir));
    let files;
    try {
      files = await readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      log('ERROR', 'task-store', 'Failed to read tasks directory', {
        dir,
        error: err.message,
      });
      continue;
    }

    const jsonFiles = files.filter(
      (f) => f.startsWith('task_') && f.endsWith('.json')
    );

    for (const file of jsonFiles) {
      const filePath = path.join(dir, file);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const data = JSON.parse(raw);
        tasks.push({
          id: data.id || file.replace(/^task_/, '').replace(/\.json$/, ''),
          title: data.title || null,
          status: data.status || 'unknown',
          assignee: data.assignee || agentName,
          updated: data.updated || data.updatedAt || null,
          workspace: agentName,
        });
      } catch (err) {
        log('WARN', 'task-store', 'Failed to parse task file', {
          file,
          error: err.message,
        });
      }
    }
  }

  return tasks;
}

/**
 * Get the resolved workspaces directory path.
 * @returns {string}
 */
export function getTasksDir() {
  return CLI_WORKSPACES_DIR;
}
