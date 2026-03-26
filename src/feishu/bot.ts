/**
 * 飞书 Bot — WebSocket 长连接 + 消息处理
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import chalk from 'chalk';
import { handleMessage } from '../agent/handler.js';
import { initMemory } from '../memory/store.js';
import { startChannelBridge } from '../channel/bridge.js';
import type { Config } from '../config.js';

// 消息去重
const processed = new Map<string, number>();
function isDuplicate(msgId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of processed) { if (now - ts > 300_000) processed.delete(id); }
  if (processed.has(msgId)) return true;
  processed.set(msgId, now);
  return false;
}

// 随机表情
const EMOJIS = ['ROCKET', 'LIGHTNING', 'SPARKLES', 'RAINBOW', 'FIRE', 'COOL', 'PARTY', 'BLUSH', 'ALIEN', 'ROBOT'];

export async function startFeishuBot(config: Config, workDir: string, enableChannel: boolean) {
  // 初始化记忆
  initMemory();
  console.log(chalk.green('✅ 记忆系统已初始化 (SQLite)'));

  // 初始化 Claude Code Channel (async with health check)
  if (config.claudeCode.enabled && enableChannel) {
    const ok = await startChannelBridge(config, workDir);
    if (ok) {
      console.log(chalk.green('✅ Claude Code Channel 已启动'));
      if (config.claudeCode.skipPermissions) {
        console.log(chalk.yellow('  ⚠️  skipPermissions=true — Claude Code runs without safety prompts'));
      }
      console.log(chalk.gray(`  结果发送: ${config.claudeCode.resultDelivery === 'source' ? '发到触发聊天' : '私发管理员'}`));
    } else {
      console.log(chalk.red('❌ Claude Code Channel 启动失败（检查上方错误）'));
      console.log(chalk.gray('  Agent 仍可正常工作，但无法委派 Claude Code 任务'));
    }
  }

  // 创建飞书客户端
  const larkClient = new Lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  });

  // 事件分发器
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      try {
        await onMessage(data, larkClient, config);
      } catch (err: any) {
        console.error(chalk.red('消息处理异常:'), err.message);
      }
    },
  });

  // WebSocket 长连接
  const wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
    autoReconnect: true,
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  console.log(chalk.green('✅ 飞书 WebSocket 已连接，等待消息...\n'));

  // 保持进程
  process.on('SIGINT', () => { console.log('\n👋 再见'); process.exit(0); });
  process.on('SIGTERM', () => process.exit(0));
}

async function onMessage(data: any, larkClient: Lark.Client, config: Config) {
  const message = data.message;
  if (!message || message.message_type !== 'text') return;
  if (isDuplicate(message.message_id)) return;

  const chatId = message.chat_id;
  const senderOpenId = data.sender?.sender_id?.open_id || '';

  let text = '';
  try { text = JSON.parse(message.content).text?.trim() || ''; } catch { return; }
  text = text.replace(/@_user_\d+/g, '').trim();
  if (!text) return;

  console.log(chalk.blue(`📨 ${text.slice(0, 60)}${text.length > 60 ? '...' : ''}`));

  // 添加思考表情
  let reactionId: string | null = null;
  const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  try {
    const resp = await larkClient.im.v1.messageReaction.create({
      path: { message_id: message.message_id },
      data: { reaction_type: { emoji_type: emoji } },
    });
    reactionId = (resp as any)?.data?.reaction_id ?? null;
  } catch { /* ignore */ }

  // Agent 处理
  const reply = await handleMessage(text, chatId, senderOpenId, config);

  // 移除表情
  if (reactionId) {
    try {
      await larkClient.im.v1.messageReaction.delete({
        path: { message_id: message.message_id, reaction_id: reactionId },
      });
    } catch { /* ignore */ }
  }

  // 发送回复
  if (reply.length > 200) {
    await larkClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '🤖 Agent' }, template: 'blue' },
          elements: [{ tag: 'markdown', content: reply }],
        }),
      },
    });
  } else {
    await larkClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: reply }) },
    });
  }

  console.log(chalk.green(`✅ 回复 (${reply.length} 字)`));
}
