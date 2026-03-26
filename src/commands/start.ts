/**
 * feishu-cc-agent start — 启动所有服务
 *
 * 单进程运行:
 *   1. 飞书 WebSocket 长连接（接收消息）
 *   2. AI Agent（理解意图 + 工具调用）
 *   3. Claude Code Channel MCP（可选，本地执行）
 */

import chalk from 'chalk';
import { loadConfig, isConfigured } from '../config.js';
import { startFeishuBot } from '../feishu/bot.js';
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
  console.log(`💻 Claude Code: ${config.claudeCode.enabled && options.channel ? '启用' : '关闭'}`);
  console.log(`📁 工作目录: ${workDir}`);
  console.log(`👑 管理员: ${config.permissions.adminOpenIds.length} 人`);
  console.log('');

  // 启动飞书 Bot（包含 Agent + Channel）
  await startFeishuBot(config, workDir, options.channel);
}
