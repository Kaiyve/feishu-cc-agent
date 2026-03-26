/**
 * feishu-cc-agent init — 交互式配置
 *
 * 1. 配置飞书 App（App ID + App Secret）
 * 2. 配置 AI API（任意 OpenAI 兼容端点）
 * 3. 配置 Claude Code（是否启用 Channel）
 * 4. 自动部署 Claude Code Skills
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadConfig, saveConfig, CONFIG_FILE, type Config } from '../config.js';
import { deploySkills } from '../skills/deploy.js';

export async function init() {
  console.log(chalk.bold('\n🚀 feishu-cc-agent 配置向导\n'));

  const existing = loadConfig();

  // ═══ Step 1: 飞书 App ═══
  console.log(chalk.cyan('📱 Step 1/4: 飞书机器人配置'));
  console.log(chalk.gray('  在飞书开放平台 (open.feishu.cn) 创建应用，获取 App ID 和 App Secret'));
  console.log(chalk.gray('  需要权限: im:message, im:message:send_as_bot'));
  console.log(chalk.gray('  事件订阅: 长连接模式 + im.message.receive_v1\n'));

  const feishu = await inquirer.prompt([
    {
      type: 'input',
      name: 'appId',
      message: '飞书 App ID:',
      default: existing.feishu.appId,
      validate: (v: string) => v.length > 0 || '必填',
    },
    {
      type: 'password',
      name: 'appSecret',
      message: '飞书 App Secret:',
      default: existing.feishu.appSecret,
      validate: (v: string) => v.length > 0 || '必填',
    },
  ]);

  // ═══ Step 2: AI API ═══
  console.log(chalk.cyan('\n🧠 Step 2/4: AI Agent 配置'));
  console.log(chalk.gray('  支持任意 OpenAI 兼容 API（智谱、DeepSeek、LiteLLM、OpenRouter 等）'));
  console.log(chalk.gray('  Agent 负责理解意图、智能路由、回答简单问题\n'));

  const presets = [
    { name: '智谱 (zhipuai.cn)', value: { url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' } },
    { name: 'DeepSeek', value: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } },
    { name: 'OpenRouter', value: { url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' } },
    { name: 'LiteLLM (自定义代理)', value: { url: '', model: '' } },
    { name: 'OpenAI', value: { url: 'https://api.openai.com/v1', model: 'gpt-4o' } },
    { name: '自定义', value: { url: '', model: '' } },
  ];

  const { preset } = await inquirer.prompt([
    { type: 'list', name: 'preset', message: 'AI 提供商:', choices: presets },
  ]);

  const agent = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'API Base URL:',
      default: preset.url || existing.agent.baseUrl,
      validate: (v: string) => v.startsWith('http') || '需要完整 URL',
    },
    {
      type: 'password',
      name: 'apiKey',
      message: 'API Key:',
      default: existing.agent.apiKey,
      validate: (v: string) => v.length > 0 || '必填',
    },
    {
      type: 'input',
      name: 'model',
      message: '模型名:',
      default: preset.model || existing.agent.model,
    },
  ]);

  // ═══ Step 3: Claude Code ═══
  console.log(chalk.cyan('\n💻 Step 3/4: Claude Code 配置'));
  console.log(chalk.gray('  Claude Code 在本地 Mac 运行，处理需要文件系统/Shell 的复杂任务'));
  console.log(chalk.gray('  需要 Claude Pro/Max 订阅 或 Anthropic API Key\n'));

  const cc = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enabled',
      message: '启用 Claude Code Channel（本地执行复杂任务）?',
      default: existing.claudeCode.enabled,
    },
    {
      type: 'confirm',
      name: 'skipPermissions',
      message: '跳过权限确认（--dangerously-skip-permissions）?',
      default: existing.claudeCode.skipPermissions,
      when: (a: any) => a.enabled,
    },
  ]);

  // ═══ Step 4: 管理员 ═══
  console.log(chalk.cyan('\n🔐 Step 4/4: 管理员配置'));
  console.log(chalk.gray('  管理员可以执行 Claude Code 任务、写全局记忆'));
  console.log(chalk.gray('  首次使用时在飞书发消息，从日志中获取你的 open_id\n'));

  const { adminIds } = await inquirer.prompt([
    {
      type: 'input',
      name: 'adminIds',
      message: '管理员 open_id（逗号分隔，可后续添加）:',
      default: existing.permissions.adminOpenIds.join(','),
    },
  ]);

  // ═══ 保存配置 ═══
  const config: Config = {
    feishu: feishu,
    agent: {
      baseUrl: agent.baseUrl,
      apiKey: agent.apiKey,
      model: agent.model,
      maxTurns: 10,
      timeoutMs: 120_000,
    },
    permissions: {
      adminOpenIds: adminIds.split(',').map((s: string) => s.trim()).filter(Boolean),
    },
    claudeCode: {
      enabled: cc.enabled ?? true,
      skipPermissions: cc.skipPermissions ?? true,
      resumeSession: true,
    },
  };

  saveConfig(config);
  console.log(chalk.green(`\n✅ 配置已保存: ${CONFIG_FILE}`));

  // ═══ 部署 Skills ═══
  if (config.claudeCode.enabled) {
    console.log(chalk.cyan('\n📦 部署 Claude Code Skills...'));
    await deploySkills();
    console.log(chalk.green('✅ Skills 已部署'));
  }

  console.log(chalk.bold('\n🎉 配置完成！运行以下命令启动:'));
  console.log(chalk.yellow('  feishu-cc-agent start\n'));
}
