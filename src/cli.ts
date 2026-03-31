#!/usr/bin/env node
/**
 * feishu-cc-agent CLI
 *
 * 命令:
 *   init   — 交互式配置（飞书 App + AI API + Claude Code）
 *   start  — 启动服务（飞书 Bot + Agent + Claude Code Channel）
 *   status — 查看运行状态
 */

import { Command } from 'commander';
import { init } from './commands/init.js';
import { start } from './commands/start.js';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('feishu-cc-agent')
  .description('飞书 + AI Agent + Claude Code — 从手机操控你的编程 AI')
  .version(pkg.version);

program
  .command('init')
  .description('交互式配置（飞书 App + AI API Key + Claude Code Skills）')
  .action(init);

program
  .command('start')
  .description('启动服务')
  .option('-d, --dir <path>', '工作目录（Claude Code 在此目录下运行）', '.')
  .action(start);

program.parse();
