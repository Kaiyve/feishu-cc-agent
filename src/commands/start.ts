/**
 * feishu-cc-agent start — start all services
 *
 * Single process:
 *   1. Feishu WebSocket (receive messages)
 *   2. AI Agent (intent + tool calls)
 *   3. Claude Code Bridge (optional, local execution)
 */

import chalk from 'chalk';
import { loadConfig, isConfigured } from '../config.js';
import { startFeishuBot } from '../feishu/bot.js';
import { ensureClaude } from '../claude-check.js';
import { resolve } from 'path';

interface StartOptions {
  dir: string;
  channel: boolean;
}

export async function start(options: StartOptions) {
  if (!isConfigured()) {
    console.log(chalk.red('❌ 尚未配置。请先运行: feishu-cc-agent init'));
    process.exit(1);
  }

  const config = loadConfig();
  const workDir = resolve(options.dir);

  console.log(chalk.bold('\n═══ feishu-cc-agent ═══'));
  console.log(`📱 飞书 App: ${config.feishu.appId}`);
  console.log(`🧠 AI Model: ${config.agent.model}`);
  console.log(`📁 工作目录: ${workDir}`);
  console.log(`👑 管理员: ${config.permissions.adminOpenIds.length} 人`);

  // Claude Code pre-flight check
  let enableCC = config.claudeCode.enabled && options.channel;
  if (enableCC) {
    const ready = await ensureClaude(false);
    if (!ready) {
      console.log(chalk.yellow('\n⚠️  Claude Code 未就绪，将以 Agent-only 模式启动。'));
      console.log(chalk.gray('  Agent 正常工作，但无法委派本地执行任务。\n'));
      enableCC = false;
    }
  }

  console.log(`💻 Claude Code: ${enableCC ? chalk.green('启用') : chalk.gray('关闭')}`);
  console.log('');

  // Start Feishu Bot (includes Agent + Channel)
  await startFeishuBot(config, workDir, enableCC);
}
