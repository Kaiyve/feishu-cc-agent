/**
 * MCP Channel Server — runs inside Claude Code as a subprocess
 *
 * Started by: claude --dangerously-load-development-channels server:feishu-agent
 *
 * Architecture:
 *   Feishu Bot (separate process) → writes tasks to SQLite
 *   This server (inside Claude Code) → polls SQLite → pushes to Claude Code
 *   Claude Code → calls feishu_reply tool → updates SQLite
 *   Feishu Bot → polls SQLite for results → sends Feishu notification
 *
 * Communication: SQLite at ~/.feishu-cc-agent/memory.db
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

// ═══ Config ═══

const CONFIG_DIR = resolve(homedir(), '.feishu-cc-agent');
const CONFIG_FILE = resolve(CONFIG_DIR, 'config.json');
const DB_PATH = resolve(CONFIG_DIR, 'memory.db');
const POLL_INTERVAL_MS = 10_000;

interface ChannelConfig {
  feishu: { appId: string; appSecret: string };
  claudeCode: { taskTimeoutMin?: number };
}

function loadChannelConfig(): ChannelConfig {
  if (existsSync(CONFIG_FILE)) {
    try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); } catch { /* fall through */ }
  }
  return { feishu: { appId: '', appSecret: '' }, claudeCode: {} };
}

const config = loadChannelConfig();
const TASK_TIMEOUT_MS = (config.claudeCode.taskTimeoutMin || 60) * 60 * 1000;

// ═══ Logging (stderr only — stdout is MCP stdio) ═══

function log(msg: string) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] [feishu-agent] ${msg}\n`);
}

// ═══ SQLite ═══

let db: any = null;

async function initDb() {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  db = new BetterSqlite3(DB_PATH);
  db.pragma('journal_mode = WAL');
  log(`DB opened: ${DB_PATH}`);
}

function fetchNextTask(): any {
  if (!db) return null;
  return db.prepare(
    `SELECT * FROM cc_tasks WHERE status = 'pending' ORDER BY id ASC LIMIT 1`
  ).get() || null;
}

function claimTask(id: number) {
  if (!db) return;
  db.prepare(
    `UPDATE cc_tasks SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`
  ).run(id);
}

function completeTask(id: number, status: 'done' | 'failed', result: string) {
  if (!db) return;
  db.prepare(
    `UPDATE cc_tasks SET status = ?, result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(status, result.slice(0, 50_000), id);
}

// ═══ Active Task ═══

let activeTask: { id: number; chatId: string; senderOpenId: string } | null = null;

// ═══ Feishu API (for feishu_send_image / feishu_send_message) ═══

let feishuTokenCache: { token: string; expiresAt: number } | null = null;

async function getFeishuToken(): Promise<string> {
  if (feishuTokenCache && Date.now() < feishuTokenCache.expiresAt) {
    return feishuTokenCache.token;
  }
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.appSecret }),
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(`Feishu token error: ${data.msg}`);
  if (!data.tenant_access_token) throw new Error('Missing tenant_access_token');
  feishuTokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + (data.expire - 300) * 1000 };
  return data.tenant_access_token;
}

async function feishuSendMessage(receiveIdType: string, receiveId: string, msgType: string, content: string) {
  const token = await getFeishuToken();
  return fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content }),
  }).then(r => r.json());
}

async function feishuUploadImage(filePath: string): Promise<string> {
  const token = await getFeishuToken();
  const { readFileSync: readFile } = await import('fs');
  const fileData = readFile(filePath);
  const formData = new FormData();
  formData.append('image_type', 'message');
  formData.append('image', new Blob([fileData]), 'image.png');
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });
  const data = await res.json() as any;
  if (data.data?.image_key) return data.data.image_key;
  throw new Error(`Image upload failed: ${JSON.stringify(data)}`);
}

// ═══ MCP Server ═══

const mcp = new Server(
  { name: 'feishu-agent', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'You receive tasks from Feishu users via the feishu-agent channel.',
      'Messages arrive as <channel source="feishu-agent"> notifications.',
      'After completing a task, you MUST call feishu_reply to send results back.',
      'You run on a local Mac with full filesystem, Shell, and Git access.',
      'Always reply in the same language as the user\'s request.',
      '',
      '## Important',
      '- Think deeply before acting. Use extended reasoning for complex tasks.',
      '- If the task mentions a skill (e.g. /xhs-scout, /brow-pro), use that skill.',
      '- Keep responses concise and well-organized.',
    ].join('\n'),
  },
);

// ─── Tools ───

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'feishu_reply',
      description: 'Send task result back to Feishu and mark task complete. MUST call this when done.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'Reply content' },
          status: { type: 'string', enum: ['done', 'failed'], description: 'Task status' },
        },
        required: ['text', 'status'],
      },
    },
    {
      name: 'feishu_send_image',
      description: 'Upload a local image file and send it to a Feishu user or chat.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: 'Local image file path' },
          receive_id: { type: 'string', description: 'Feishu open_id or chat_id' },
          receive_id_type: { type: 'string', enum: ['open_id', 'chat_id'], default: 'open_id' },
        },
        required: ['file_path', 'receive_id'],
      },
    },
    {
      name: 'feishu_send_message',
      description: 'Send a text message to a Feishu user or chat.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          receive_id: { type: 'string', description: 'Feishu open_id or chat_id' },
          receive_id_type: { type: 'string', enum: ['open_id', 'chat_id'], default: 'open_id' },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['receive_id', 'text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'feishu_reply') {
    const { text, status } = args as { text: string; status: 'done' | 'failed' };
    if (activeTask) {
      const truncated = text.slice(0, 50_000);
      completeTask(activeTask.id, status, truncated);
      log(`Task #${activeTask.id} ${status} (${text.length} chars)`);
      activeTask = null;
      return { content: [{ type: 'text' as const, text: 'Result saved. Feishu notification will be sent by the bot process.' }] };
    }
    return { content: [{ type: 'text' as const, text: 'No active task.' }] };
  }

  if (name === 'feishu_send_image') {
    const { file_path, receive_id, receive_id_type } = args as any;
    if (!existsSync(file_path)) return { content: [{ type: 'text' as const, text: `File not found: ${file_path}` }] };
    if (!config.feishu.appId) return { content: [{ type: 'text' as const, text: 'Feishu credentials not configured' }] };
    try {
      const imageKey = await feishuUploadImage(file_path);
      await feishuSendMessage(receive_id_type || 'open_id', receive_id, 'image', JSON.stringify({ image_key: imageKey }));
      return { content: [{ type: 'text' as const, text: `Image sent (key: ${imageKey})` }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }] };
    }
  }

  if (name === 'feishu_send_message') {
    const { receive_id, receive_id_type, text } = args as any;
    if (!config.feishu.appId) return { content: [{ type: 'text' as const, text: 'Feishu credentials not configured' }] };
    try {
      await feishuSendMessage(receive_id_type || 'open_id', receive_id, 'text', JSON.stringify({ text }));
      return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }] };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ═══ Poll + Push ═══

async function pollAndPush() {
  while (true) {
    try {
      if (!activeTask) {
        const task = fetchNextTask();
        if (task) {
          claimTask(task.id);
          activeTask = { id: task.id, chatId: task.chat_id, senderOpenId: task.sender_open_id };
          log(`Claimed task #${task.id}: ${task.prompt.slice(0, 80)}...`);

          // Push to Claude Code session
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: task.prompt,
              meta: {
                task_id: String(task.id),
                sender: task.sender_open_id,
                chat_id: task.chat_id,
              },
            },
          });
          log(`Pushed task #${task.id} to Claude Code`);

          // Timeout guard
          const taskId = task.id;
          setTimeout(() => {
            if (activeTask?.id === taskId) {
              log(`Task #${taskId} timed out (${TASK_TIMEOUT_MS / 60_000} min)`);
              completeTask(taskId, 'failed', `Task timed out (${TASK_TIMEOUT_MS / 60_000} minutes)`);
              activeTask = null;
            }
          }, TASK_TIMEOUT_MS);
        }
      }
    } catch (err: any) {
      log(`Poll error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ═══ Main ═══

async function main() {
  log('Starting Feishu Agent Channel Server');

  if (!existsSync(DB_PATH)) {
    log(`ERROR: Database not found at ${DB_PATH}`);
    log('Run "feishu-cc-agent start" first to initialize the database.');
    process.exit(1);
  }

  await initDb();

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log('Connected to Claude Code');

  pollAndPush().catch(err => {
    log(`Poll loop crashed: ${err.message}`);
  });
}

main().catch(err => {
  process.stderr.write(`Channel server failed: ${err.message}\n`);
  process.exit(1);
});
