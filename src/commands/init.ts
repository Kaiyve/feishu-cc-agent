/**
 * feishu-cc-agent init — 交互式配置
 *
 * 1. 飞书 App（自动打开创建页 + 验证凭据 + 检查权限）
 * 2. AI API（任意 OpenAI 兼容端点）
 * 3. Claude Code（Channel 配置）
 * 4. 管理员 open_id
 * 5. 自动部署 Skills
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadConfig, saveConfig, CONFIG_FILE, type Config } from '../config.js';
import { deploySkills } from '../skills/deploy.js';
import { ensureClaude } from '../claude-check.js';
import { exec } from 'child_process';

// ═══ 飞书凭据验证 ═══

async function verifyFeishuCredentials(appId: string, appSecret: string): Promise<{
  ok: boolean;
  error?: string;
  token?: string;
}> {
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const data = await res.json() as any;
    if (data.code === 0 && data.tenant_access_token) {
      return { ok: true, token: data.tenant_access_token };
    }
    return { ok: false, error: data.msg || `code ${data.code}` };
  } catch (err: any) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

async function checkFeishuPermissions(token: string): Promise<{
  hasMessage: boolean;
  hasSendBot: boolean;
}> {
  // Try sending a test request to check permissions
  // If we get 99991403 (no permission), the permission is missing
  // If we get other errors (like invalid chat_id), the permission exists
  let hasMessage = false;
  let hasSendBot = false;

  try {
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/chats?page_size=1', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json() as any;
    // If we can list chats, we have basic im permissions
    hasMessage = data.code === 0;
  } catch { /* assume no */ }

  try {
    // Check if bot can send messages by trying to list bot chats
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/chats?page_size=1', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json() as any;
    hasSendBot = data.code === 0;
  } catch { /* assume no */ }

  return { hasMessage, hasSendBot };
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

// ═══ Init ═══

export async function init() {
  console.log(chalk.bold('\n🚀 feishu-cc-agent Setup Wizard\n'));

  const existing = loadConfig();

  // ═══ Step 1: 飞书 App ═══
  console.log(chalk.cyan('📱 Step 1/4: Feishu Bot Setup'));
  console.log('');
  console.log(chalk.white('  You need a Feishu app with Bot capability. 3 steps:'));
  console.log('');
  console.log(chalk.white('  1. Create app → Add Bot capability'));
  console.log(chalk.white('  2. Permissions → Add: im:message + im:message:send_as_bot'));
  console.log(chalk.white('  3. Events → Long Connection mode + im.message.receive_v1'));
  console.log('');

  const { openDocs } = await inquirer.prompt([{
    type: 'confirm',
    name: 'openDocs',
    message: 'Open Feishu developer console in browser?',
    default: !existing.feishu.appId,
  }]);

  if (openDocs) {
    openBrowser('https://open.feishu.cn/app');
    console.log(chalk.gray('\n  Browser opened. Create your app, then paste credentials below.\n'));
  }

  let feishuValid = false;
  let feishu = { appId: existing.feishu.appId, appSecret: existing.feishu.appSecret };

  while (!feishuValid) {
    feishu = await inquirer.prompt([
      {
        type: 'input',
        name: 'appId',
        message: 'App ID (cli_xxx):',
        default: feishu.appId,
        validate: (v: string) => v.startsWith('cli_') || 'App ID starts with cli_',
      },
      {
        type: 'password',
        name: 'appSecret',
        message: 'App Secret:',
        default: feishu.appSecret,
        validate: (v: string) => v.length > 10 || 'Too short',
      },
    ]);

    // Verify credentials
    console.log(chalk.gray('  Verifying credentials...'));
    const result = await verifyFeishuCredentials(feishu.appId, feishu.appSecret);

    if (result.ok) {
      console.log(chalk.green('  ✅ Credentials valid!'));

      // Check permissions
      console.log(chalk.gray('  Checking permissions...'));
      const perms = await checkFeishuPermissions(result.token!);

      if (!perms.hasMessage) {
        console.log(chalk.yellow('  ⚠️  Missing permission: im:message'));
        console.log(chalk.gray('  → Add it at: Permissions & Scopes → Search "im:message" → Activate'));
        const permUrl = `https://open.feishu.cn/app/${feishu.appId}/permission`;
        const { openPerm } = await inquirer.prompt([{
          type: 'confirm', name: 'openPerm', message: 'Open permissions page?', default: true,
        }]);
        if (openPerm) openBrowser(permUrl);
      }

      feishuValid = true;
    } else {
      console.log(chalk.red(`  ❌ Invalid credentials: ${result.error}`));
      const { retry } = await inquirer.prompt([{
        type: 'confirm', name: 'retry', message: 'Try again?', default: true,
      }]);
      if (!retry) {
        console.log(chalk.yellow('  Skipping validation. You can fix credentials later in config.json.'));
        feishuValid = true;
      }
    }
  }

  // Check event subscription
  console.log('');
  console.log(chalk.gray('  ⚠️  Make sure Event Subscription is set to "Long Connection" mode'));
  console.log(chalk.gray('  and event im.message.receive_v1 is subscribed.'));
  console.log(chalk.gray(`  → ${`https://open.feishu.cn/app/${feishu.appId}/event`}`));
  console.log('');

  // ═══ Step 2: AI API ═══
  console.log(chalk.cyan('🧠 Step 2/4: AI Agent'));
  console.log(chalk.gray('  Any OpenAI-compatible API works (ZhiPu, DeepSeek, OpenRouter, etc.)'));
  console.log(chalk.gray('  The Agent handles intent recognition and simple Q&A.\n'));

  const presets = [
    { name: 'ZhiPu (zhipuai.cn)', value: { url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' } },
    { name: 'DeepSeek', value: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } },
    { name: 'OpenRouter', value: { url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' } },
    { name: 'OpenAI', value: { url: 'https://api.openai.com/v1', model: 'gpt-4o' } },
    { name: 'Custom', value: { url: '', model: '' } },
  ];

  const { preset } = await inquirer.prompt([
    { type: 'list', name: 'preset', message: 'AI Provider:', choices: presets },
  ]);

  const agent = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'API Base URL:',
      default: preset.url || existing.agent.baseUrl,
      validate: (v: string) => v.startsWith('http') || 'Full URL required',
    },
    {
      type: 'password',
      name: 'apiKey',
      message: 'API Key:',
      default: existing.agent.apiKey,
      validate: (v: string) => v.length > 0 || 'Required',
    },
    {
      type: 'input',
      name: 'model',
      message: 'Model name:',
      default: preset.model || existing.agent.model,
    },
  ]);

  // ═══ Step 3: Claude Code ═══
  console.log(chalk.cyan('\n💻 Step 3/4: Claude Code'));
  console.log(chalk.gray('  Runs on your local Mac — handles complex tasks via MCP Channel.'));
  console.log(chalk.gray('  Requires Claude Pro/Max subscription or Anthropic API Key.\n'));

  const cc = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enabled',
      message: 'Enable Claude Code Channel?',
      default: existing.claudeCode.enabled,
    },
    {
      type: 'confirm',
      name: 'skipPermissions',
      message: '⚠️  Bypass permissions (no confirmation prompts)?',
      default: existing.claudeCode.skipPermissions,
      when: (a: any) => a.enabled,
    },
    {
      type: 'list',
      name: 'resultDelivery',
      message: 'Result delivery:',
      choices: [
        { name: 'DM the admin (recommended, keeps code private)', value: 'private' },
        { name: 'Reply to trigger chat', value: 'source' },
      ],
      default: existing.claudeCode.resultDelivery || 'private',
      when: (a: any) => a.enabled,
    },
    {
      type: 'number',
      name: 'taskTimeoutMin',
      message: 'Task timeout (minutes):',
      default: existing.claudeCode.taskTimeoutMin || 60,
      when: (a: any) => a.enabled,
    },
  ]);

  // Check Claude Code
  if (cc.enabled) {
    const ready = await ensureClaude(true);
    if (!ready) {
      console.log(chalk.yellow('\n  Claude Code not ready. You can install/login later.'));
      console.log(chalk.gray('  Install: npm install -g @anthropic-ai/claude-code'));
      console.log(chalk.gray('  Login:   claude login\n'));
    }
  }

  // ═══ Step 4: Admin ═══
  console.log(chalk.cyan('\n🔐 Step 4/4: Admin'));
  console.log(chalk.gray('  Admins can trigger Claude Code tasks and write global memories.'));
  console.log(chalk.gray('  Don\'t know your open_id? Start the bot, send a message, check logs.\n'));

  const { adminIds } = await inquirer.prompt([{
    type: 'input',
    name: 'adminIds',
    message: 'Admin open_id (comma-separated, can add later):',
    default: existing.permissions.adminOpenIds.join(','),
  }]);

  // ═══ Save ═══
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
      resultDelivery: cc.resultDelivery ?? 'private',
      taskTimeoutMin: cc.taskTimeoutMin || 60,
    },
  };

  saveConfig(config);
  console.log(chalk.green(`\n✅ Config saved: ${CONFIG_FILE}`));

  // Deploy Skills
  if (config.claudeCode.enabled) {
    console.log(chalk.cyan('\n📦 Deploying Claude Code Skills...'));
    await deploySkills();
    console.log(chalk.green('✅ Skills deployed'));
  }

  // Done
  console.log(chalk.bold('\n🎉 Setup complete! Start with:'));
  console.log(chalk.yellow('  feishu-cc-agent start\n'));
}
