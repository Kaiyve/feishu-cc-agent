/**
 * Claude Code Bridge — spawn claude -p for each task
 *
 * Tasks are persisted to SQLite so they survive process restarts.
 * Each task spawns a fresh `claude -p --bare` process.
 *
 * Result delivery: configurable via config.claudeCode.resultDelivery
 *   - 'private': always DM the admin who triggered (default)
 *   - 'source':  reply to the chat where task was triggered
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import { homedir } from 'os';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import type { Config } from '../config.js';
import chalk from 'chalk';

let bridge: ChannelBridge | null = null;

export function getChannelBridge(): ChannelBridge | null {
  return bridge;
}

// ═══ Task Persistence (SQLite via dynamic import for ESM compat) ═══

let taskDb: any = null;
let taskDbReady = false;

async function initTaskDb(): Promise<boolean> {
  try {
    // Dynamic import — works in both ESM and CJS
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const dbDir = resolve(homedir(), '.feishu-cc-agent');
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, 'memory.db');

    taskDb = new BetterSqlite3(dbPath);
    taskDb.exec(`
      CREATE TABLE IF NOT EXISTS cc_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_open_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Recover any tasks that were running when process died
    taskDb.prepare(`UPDATE cc_tasks SET status = 'pending' WHERE status = 'running'`).run();
    taskDbReady = true;
    return true;
  } catch (err: any) {
    console.error(chalk.red(`  ❌ Task DB init failed: ${err.message}`));
    console.error(chalk.red(`     Claude Code tasks will NOT be persisted.`));
    taskDb = null;
    taskDbReady = false;
    return false;
  }
}

function persistTask(prompt: string, chatId: string, senderOpenId: string): number {
  if (!taskDb) return 0;
  const result = taskDb.prepare(
    `INSERT INTO cc_tasks (prompt, chat_id, sender_open_id, status) VALUES (?, ?, ?, 'pending')`
  ).run(prompt, chatId, senderOpenId);
  return result.lastInsertRowid as number;
}

function updateTaskStatus(id: number, status: string, result?: string) {
  if (!taskDb || !id) return;
  taskDb.prepare(
    `UPDATE cc_tasks SET status = ?, result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(status, result?.slice(0, 50_000) ?? null, id);
}

function getPendingTasks(): Array<{ id: number; prompt: string; chat_id: string; sender_open_id: string }> {
  if (!taskDb) return [];
  return taskDb.prepare(`SELECT id, prompt, chat_id, sender_open_id FROM cc_tasks WHERE status = 'pending' ORDER BY id ASC`).all();
}

// ═══ Result File Storage ═══

const RESULT_DIR = resolve(homedir(), '.feishu-cc-agent', 'results');

function saveResultToFile(taskId: number, content: string): string {
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const filePath = resolve(RESULT_DIR, `task-${taskId}.txt`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ═══ Bridge ═══

interface ActiveTask {
  dbId: number;
  prompt: string;
  chatId: string;
  senderOpenId: string;
}

export class ChannelBridge {
  private activeTask: ActiveTask | null = null;
  private processing = false;
  private config: Config;
  private workDir: string;
  private healthy = false;

  constructor(config: Config, workDir: string) {
    this.config = config;
    this.workDir = workDir;
  }

  /**
   * Async initialization — must be called after constructor.
   * Claude CLI availability is checked by start.ts before this is called.
   */
  async init(): Promise<boolean> {
    // Init task DB
    const dbOk = await initTaskDb();
    if (!dbOk) {
      console.error(chalk.yellow('  ⚠️ Task persistence disabled. Tasks will be in-memory only.'));
    } else {
      console.log(chalk.gray('  ✓ Task DB ready'));
    }

    this.healthy = true;

    // Process any recovered pending tasks
    if (dbOk) {
      const pending = getPendingTasks();
      if (pending.length > 0) {
        console.log(chalk.yellow(`  📋 Recovered ${pending.length} pending task(s)`));
        this.processNext();
      }
    }

    return true;
  }

  async submitTask(prompt: string, chatId: string, senderOpenId: string): Promise<any> {
    if (!this.healthy) {
      return { error: 'Claude Code Bridge is not healthy. Check startup logs.' };
    }

    const dbId = persistTask(prompt, chatId, senderOpenId);
    if (dbId === 0 && !taskDb) {
      // In-memory fallback: queue directly
      console.log(chalk.yellow(`  📋 CC task (in-memory): ${prompt.slice(0, 60)}...`));
    } else {
      console.log(chalk.yellow(`  📋 CC task #${dbId}: ${prompt.slice(0, 60)}...`));
    }

    this.processNext();

    return {
      submitted: true,
      taskId: dbId || 'mem',
      message: `Task #${dbId || 'mem'} submitted to Claude Code. Estimated 1-5 minutes.`,
    };
  }

  private async processNext() {
    if (this.processing) return;

    const pending = getPendingTasks();
    if (pending.length === 0) return;

    this.processing = true;
    const task = pending[0];
    this.activeTask = {
      dbId: task.id,
      prompt: task.prompt,
      chatId: task.chat_id,
      senderOpenId: task.sender_open_id,
    };

    updateTaskStatus(task.id, 'running');

    try {
      console.log(chalk.yellow(`  🚀 Running CC task #${task.id}`));
      const result = await this.executeClaudeCode(task.prompt);
      console.log(chalk.green(`  ✅ CC task #${task.id} done (${result.length} chars)`));

      updateTaskStatus(task.id, 'done', result);
      await this.notifyResult(this.activeTask, result, 'done');
    } catch (err: any) {
      console.error(chalk.red(`  ❌ CC task #${task.id} failed: ${err.message}`));
      updateTaskStatus(task.id, 'failed', err.message);
      await this.notifyResult(this.activeTask, err.message, 'failed');
    } finally {
      this.activeTask = null;
      this.processing = false;
      const remaining = getPendingTasks();
      if (remaining.length > 0) this.processNext();
    }
  }

  private executeClaudeCode(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--bare', '--max-turns', '20'];
      if (this.config.claudeCode.skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }

      const child = spawn('claude', args, {
        cwd: this.workDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.stdin.write(prompt);
      child.stdin.end();

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, 10 * 60 * 1000);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(output || '(empty output)');
        } else if (output && code !== null) {
          reject(new Error(`Claude Code exited with code ${code}.\n\nPartial output:\n${output.slice(-1000)}`));
        } else {
          reject(new Error(stderr.slice(-500) || `exit code ${code}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async notifyResult(task: ActiveTask, content: string, status: 'done' | 'failed') {
    try {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const client = new Lark.Client({
        appId: this.config.feishu.appId,
        appSecret: this.config.feishu.appSecret,
        domain: Lark.Domain.Feishu,
      });

      const title = status === 'done' ? '✅ Claude Code Done' : '❌ Claude Code Failed';
      const template = status === 'done' ? 'green' : 'red';

      // For long results: save to file, send summary to Feishu
      let text: string;
      let filePath: string | null = null;
      if (content.length > 4000) {
        filePath = saveResultToFile(task.dbId, content);
        text = content.slice(0, 3500) + `\n\n... (${content.length} chars total)\nFull result: ${filePath}`;
      } else {
        text = content;
      }

      // Determine delivery target
      const delivery = this.config.claudeCode.resultDelivery || 'private';
      const receiveIdType = delivery === 'private' ? 'open_id' : 'chat_id';
      const receiveId = delivery === 'private' ? task.senderOpenId : task.chatId;

      await client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'interactive',
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: title }, template },
            elements: [{ tag: 'markdown', content: text }],
          }),
        },
      });
    } catch (err: any) {
      console.error(chalk.red('Feishu notification failed:'), err.message);
    }
  }
}

export async function startChannelBridge(config: Config, workDir: string): Promise<boolean> {
  bridge = new ChannelBridge(config, workDir);
  const ok = await bridge.init();
  if (!ok) {
    bridge = null;
  }
  return ok;
}
