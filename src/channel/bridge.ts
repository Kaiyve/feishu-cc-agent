/**
 * Claude Code Bridge — spawn claude -p for each task
 *
 * Tasks are persisted to SQLite so they survive process restarts.
 * Each task spawns a fresh `claude -p --bare` process.
 */

import { spawn } from 'child_process';
import type { Config } from '../config.js';
import chalk from 'chalk';

let bridge: ChannelBridge | null = null;

export function getChannelBridge(): ChannelBridge | null {
  return bridge;
}

// ═══ Task Persistence (SQLite) ═══

let taskDb: any = null;

function initTaskDb() {
  try {
    const Database = require('better-sqlite3');
    const { resolve } = require('path');
    const { homedir } = require('os');
    const dbPath = resolve(homedir(), '.feishu-cc-agent', 'memory.db');
    taskDb = new Database(dbPath);
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
  } catch {
    taskDb = null;
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
  ).run(status, result?.slice(0, 5000) ?? null, id);
}

function getPendingTasks(): Array<{ id: number; prompt: string; chat_id: string; sender_open_id: string }> {
  if (!taskDb) return [];
  return taskDb.prepare(`SELECT id, prompt, chat_id, sender_open_id FROM cc_tasks WHERE status = 'pending' ORDER BY id ASC`).all();
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

  constructor(config: Config, workDir: string) {
    this.config = config;
    this.workDir = workDir;
    initTaskDb();

    // Process any recovered pending tasks
    const pending = getPendingTasks();
    if (pending.length > 0) {
      console.log(chalk.yellow(`  📋 Recovered ${pending.length} pending CC task(s) from last session`));
      this.processNext();
    }
  }

  async submitTask(prompt: string, chatId: string, senderOpenId: string): Promise<any> {
    const dbId = persistTask(prompt, chatId, senderOpenId);
    console.log(chalk.yellow(`  📋 CC task #${dbId}: ${prompt.slice(0, 60)}...`));

    this.processNext();

    return {
      submitted: true,
      taskId: dbId,
      message: `Task #${dbId} submitted to Claude Code. Estimated 1-5 minutes.`,
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
      // Process next task in queue
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
        // Fix #2: Only exit code 0 is success. Non-zero = failure even with output.
        if (code === 0) {
          resolve(output || '(empty output)');
        } else if (output && code !== null) {
          // Non-zero exit with output: report as failure but include the output
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
      const text = content.slice(0, 3000);

      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: task.chatId,
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

export function startChannelBridge(config: Config, workDir: string) {
  bridge = new ChannelBridge(config, workDir);
}
