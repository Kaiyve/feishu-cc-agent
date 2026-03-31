/**
 * feishu-cc-agent start — start all services
 *
 * Two processes:
 *   1. This process: Feishu WebSocket + AI Agent + SQLite task queue
 *   2. Claude Code (user starts separately): reads tasks via MCP Channel Server
 */

import chalk from 'chalk';
import { loadConfig, isConfigured } from '../config.js';
import { startFeishuBot } from '../feishu/bot.js';
import { resolve, dirname } from 'path';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

interface StartOptions {
  dir: string;
}

export async function start(options: StartOptions) {
  if (!isConfigured()) {
    console.log(chalk.red('❌ Not configured. Run: feishu-cc-agent init'));
    process.exit(1);
  }

  const config = loadConfig();
  const workDir = resolve(options.dir);

  console.log(chalk.bold('\n═══ feishu-cc-agent ═══'));
  console.log(`📱 Feishu App: ${config.feishu.appId}`);
  console.log(`🧠 AI Model: ${config.agent.model}`);
  console.log(`📁 Work Dir: ${workDir}`);
  console.log(`👑 Admins: ${config.permissions.adminOpenIds.length}`);

  const enableCC = config.claudeCode.enabled;
  console.log(`💻 Claude Code: ${enableCC ? chalk.green('enabled') : chalk.gray('disabled')}`);

  // Generate .mcp.json in workDir for Claude Code to discover the channel server
  if (enableCC) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const serverJsPath = resolve(__dirname, '../channel/server.js');

    const mcpConfig = {
      mcpServers: {
        'feishu-agent': {
          command: 'node',
          args: [serverJsPath],
        },
      },
    };

    const mcpJsonPath = resolve(workDir, '.mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
    console.log(chalk.gray(`  ✓ Generated ${mcpJsonPath}`));
  }

  console.log('');

  // Start Feishu Bot (includes Agent + Task Queue)
  await startFeishuBot(config, workDir, enableCC);

  // Print Claude Code startup instructions
  if (enableCC) {
    const skipFlag = config.claudeCode.skipPermissions ? ' --dangerously-skip-permissions' : '';
    console.log(chalk.cyan('\n═══ Start Claude Code in another terminal ═══'));
    console.log(chalk.yellow(`  cd ${workDir}`));
    console.log(chalk.yellow(`  claude${skipFlag} --dangerously-load-development-channels server:feishu-agent`));
    console.log(chalk.gray('\n  Tip: use tmux — tmux new -s cc'));
    console.log(chalk.gray(`  Task timeout: ${config.claudeCode.taskTimeoutMin || 60} min`));
    console.log('');
  }
}
