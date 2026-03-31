/**
 * Claude Code Bridge — SQLite task queue + result polling
 *
 * No longer spawns `claude -p`. Instead:
 *   1. submitTask() writes to SQLite cc_tasks table
 *   2. MCP Channel Server (server.ts, inside Claude Code) picks up pending tasks
 *   3. Claude Code processes the task and calls feishu_reply
 *   4. feishu_reply updates SQLite status → this bridge polls and sends Feishu notification
 *
 * Result delivery: configurable via config.claudeCode.resultDelivery
 *   - 'private': always DM the admin who triggered (default)
 *   - 'source':  reply to the chat where task was triggered
 */

import { resolve } from 'path';
import { homedir } from 'os';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import type { Config } from '../config.js';
import chalk from 'chalk';

let bridge: ChannelBridge | null = null;

export function getChannelBridge(): ChannelBridge | null {
  return bridge;
}

// ═══ Task Persistence (SQLite) ═══

let taskDb: any = null;
let taskDbReady = false;

async function initTaskDb(): Promise<boolean> {
  try {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const dbDir = resolve(homedir(), '.feishu-cc-agent');
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    const dbPath = resolve(dbDir, 'memory.db');

    taskDb = new BetterSqlite3(dbPath);
    taskDb.pragma('journal_mode = WAL');
    taskDb.exec(`
      CREATE TABLE IF NOT EXISTS cc_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_open_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        notified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Add notified column if missing (migration from old schema)
    try { taskDb.exec('ALTER TABLE cc_tasks ADD COLUMN notified INTEGER DEFAULT 0'); } catch { /* already exists */ }
    // Recover tasks that were running when process died
    taskDb.prepare(`UPDATE cc_tasks SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE status = 'running'`).run();
    taskDbReady = true;
    return true;
  } catch (err: any) {
    console.error(chalk.red(`  ❌ Task DB init failed: ${err.message}`));
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

// ═══ Result File Storage ═══

const RESULT_DIR = resolve(homedir(), '.feishu-cc-agent', 'results');

function saveResultToFile(taskId: number, content: string): string {
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const filePath = resolve(RESULT_DIR, `task-${taskId}.txt`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ═══ Bridge ═══

export class ChannelBridge {
  private config: Config;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  async init(): Promise<boolean> {
    const dbOk = await initTaskDb();
    if (!dbOk) {
      console.error(chalk.yellow('  ⚠️ Task persistence disabled.'));
      return false;
    }
    console.log(chalk.gray('  ✓ Task DB ready'));

    // Start polling for completed tasks
    this.pollTimer = setInterval(() => this.pollResults(), 5_000);
    return true;
  }

  async submitTask(prompt: string, chatId: string, senderOpenId: string): Promise<any> {
    if (!taskDbReady) {
      return { error: 'Task DB not ready. Check startup logs.' };
    }

    const dbId = persistTask(prompt, chatId, senderOpenId);
    console.log(chalk.yellow(`  📋 CC task #${dbId}: ${prompt.slice(0, 60)}...`));

    return {
      submitted: true,
      taskId: dbId,
      message: `Task #${dbId} submitted. Claude Code Channel will pick it up automatically.`,
    };
  }

  /** Poll SQLite for completed tasks and send Feishu notifications */
  private pollResults() {
    if (!taskDb) return;

    try {
      // 1. Check for completed tasks that haven't been notified
      const completed = taskDb.prepare(
        `SELECT * FROM cc_tasks WHERE status IN ('done', 'failed') AND notified = 0`
      ).all();

      for (const task of completed) {
        this.notifyResult(task).catch((err: any) => {
          console.error(chalk.red(`  Notify failed for #${task.id}: ${err.message}`));
        });
        taskDb.prepare(`UPDATE cc_tasks SET notified = 1 WHERE id = ?`).run(task.id);
      }

      // 2. Check for timed-out tasks
      const timeoutMin = this.config.claudeCode.taskTimeoutMin || 60;
      const timedOut = taskDb.prepare(
        `SELECT * FROM cc_tasks WHERE status = 'running'
         AND updated_at < datetime('now', '-${timeoutMin} minutes')`
      ).all();

      for (const task of timedOut) {
        console.log(chalk.red(`  ⏰ Task #${task.id} timed out (${timeoutMin} min)`));
        taskDb.prepare(
          `UPDATE cc_tasks SET status = 'failed', result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(`Task timed out (${timeoutMin} minutes without reply)`, task.id);
      }
    } catch (err: any) {
      // SQLite busy — skip this poll cycle
    }
  }

  private async notifyResult(task: any) {
    try {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const client = new Lark.Client({
        appId: this.config.feishu.appId,
        appSecret: this.config.feishu.appSecret,
        domain: Lark.Domain.Feishu,
      });

      const isSuccess = task.status === 'done';
      const title = isSuccess ? '✅ Claude Code Done' : '❌ Claude Code Failed';
      const template = isSuccess ? 'green' : 'red';

      let text: string;
      const content = task.result || '';
      if (content.length > 4000) {
        const filePath = saveResultToFile(task.id, content);
        text = content.slice(0, 3500) + `\n\n... (${content.length} chars)\nFull: ${filePath}`;
      } else {
        text = content || '(no output)';
      }

      // Determine delivery target
      const delivery = this.config.claudeCode.resultDelivery || 'private';
      const receiveIdType = delivery === 'private' ? 'open_id' : 'chat_id';
      const receiveId = delivery === 'private' ? task.sender_open_id : task.chat_id;

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

      console.log(chalk.green(`  📤 Task #${task.id} result sent to Feishu`));
    } catch (err: any) {
      console.error(chalk.red('Feishu notification failed:'), err.message);
    }
  }
}

export async function startChannelBridge(config: Config): Promise<boolean> {
  bridge = new ChannelBridge(config);
  const ok = await bridge.init();
  if (!ok) bridge = null;
  return ok;
}
