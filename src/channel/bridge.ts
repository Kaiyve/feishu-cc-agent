/**
 * Claude Code Channel Bridge — 本地 Claude Code 双向通信
 *
 * 启动 Claude Code 子进程（带 Channel MCP），通过任务队列通信。
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import type { Config } from '../config.js';
import chalk from 'chalk';

interface PendingTask {
  id: number;
  prompt: string;
  chatId: string;
  senderOpenId: string;
  resolve: (result: string) => void;
}

let bridge: ChannelBridge | null = null;

export function getChannelBridge(): ChannelBridge | null {
  return bridge;
}

export class ChannelBridge {
  private ccProcess: ChildProcess | null = null;
  private taskQueue: PendingTask[] = [];
  private activeTask: PendingTask | null = null;
  private taskIdCounter = 0;
  private config: Config;
  private workDir: string;

  constructor(config: Config, workDir: string) {
    this.config = config;
    this.workDir = workDir;
  }

  async submitTask(prompt: string, chatId: string, senderOpenId: string): Promise<any> {
    const id = ++this.taskIdCounter;
    console.log(chalk.yellow(`  📋 CC 任务 #${id}: ${prompt.slice(0, 60)}...`));

    // 异步模式：立即返回，结果通过飞书推送
    this.taskQueue.push({
      id,
      prompt,
      chatId,
      senderOpenId,
      resolve: () => {},
    });

    // 触发处理
    this.processNext();

    return {
      submitted: true,
      taskId: id,
      message: `任务 #${id} 已提交给 Claude Code，预计 1-5 分钟完成。`,
    };
  }

  private async processNext() {
    if (this.activeTask || this.taskQueue.length === 0) return;

    this.activeTask = this.taskQueue.shift()!;
    const task = this.activeTask;

    try {
      console.log(chalk.yellow(`  🚀 执行 CC 任务 #${task.id}`));
      const result = await this.executeClaudeCode(task.prompt);
      console.log(chalk.green(`  ✅ CC 任务 #${task.id} 完成 (${result.length} 字)`));

      // 通过飞书推送结果到来源聊天
      await this.notifyResult(task, result, 'done');
    } catch (err: any) {
      console.error(chalk.red(`  ❌ CC 任务 #${task.id} 失败: ${err.message}`));
      await this.notifyResult(task, err.message, 'failed');
    } finally {
      this.activeTask = null;
      this.processNext();
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
        if (code === 0 || output) {
          resolve(output || '(empty output)');
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

  private async notifyResult(task: PendingTask, content: string, status: 'done' | 'failed') {
    try {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const client = new Lark.Client({
        appId: this.config.feishu.appId,
        appSecret: this.config.feishu.appSecret,
        domain: Lark.Domain.Feishu,
      });

      const title = status === 'done' ? '✅ Claude Code 完成' : '❌ Claude Code 失败';
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
      console.error(chalk.red('飞书通知失败:'), err.message);
    }
  }
}

export function startChannelBridge(config: Config, workDir: string) {
  bridge = new ChannelBridge(config, workDir);
}
