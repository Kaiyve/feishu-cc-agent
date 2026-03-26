/**
 * Agent 工具注册表
 */

import { saveMemory, searchMemories, deleteMemory } from '../memory/store.js';
import type { ToolDefinition } from './api.js';
import type { Config } from '../config.js';

export interface ToolContext {
  chatId: string;
  senderOpenId: string;
  isAdmin: boolean;
  config: Config;
}

interface ToolEntry {
  definition: ToolDefinition;
  handler: (input: any, ctx: ToolContext) => Promise<any>;
  adminOnly?: boolean;
}

const TOOL_REGISTRY: Record<string, ToolEntry> = {
  // ─── Claude Code 委派 ───
  delegate_to_claude_code: {
    definition: {
      name: 'delegate_to_claude_code',
      description: '将任务委派给本地 Claude Code 执行（异步）。适用于文件操作、写代码、运行命令、恢复历史会话等。仅管理员可用。',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '给 Claude Code 的任务描述' },
        },
        required: ['prompt'],
      },
    },
    adminOnly: true,
    handler: async (input, ctx) => {
      // 通过全局事件通知 Channel
      const { getChannelBridge } = await import('../channel/bridge.js');
      const bridge = getChannelBridge();
      if (!bridge) return { error: 'Claude Code Channel 未启动' };
      return bridge.submitTask(input.prompt, ctx.chatId, ctx.senderOpenId);
    },
  },

  // ─── 记忆工具 ───
  memory_search: {
    definition: {
      name: 'memory_search',
      description: '搜索已保存的记忆',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
    handler: async (input, ctx) => searchMemories(input.query, ctx.chatId, ctx.senderOpenId),
  },

  memory_save: {
    definition: {
      name: 'memory_save',
      description: '保存一条记忆',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          content: { type: 'string' },
          type: { type: 'string', enum: ['fact', 'preference', 'insight'] },
        },
        required: ['key', 'content', 'type'],
      },
    },
    handler: async (input, ctx) => {
      saveMemory(input.key, input.content, input.type, ctx.senderOpenId);
      return { saved: true };
    },
  },

  memory_delete: {
    definition: {
      name: 'memory_delete',
      description: '删除一条记忆',
      input_schema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
    },
    handler: async (input, ctx) => {
      deleteMemory(input.key, ctx.senderOpenId);
      return { deleted: true };
    },
  },
};

export const AGENT_TOOLS: ToolDefinition[] = Object.values(TOOL_REGISTRY).map(t => t.definition);

export async function executeToolSafely(
  name: string,
  input: Record<string, any>,
  ctx: ToolContext,
): Promise<{ data?: any; error?: string }> {
  const entry = TOOL_REGISTRY[name];
  if (!entry) return { error: `未知工具: ${name}` };
  if (entry.adminOnly && !ctx.isAdmin) return { error: `${name} 需要管理员权限` };

  try {
    const result = await Promise.race([
      entry.handler(input, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 10_000)),
    ]);
    return { data: result };
  } catch (err: any) {
    return { error: `${name}: ${err.message}` };
  }
}

export function truncateResult(r: { data?: any; error?: string }, max = 4000): string {
  if (r.error) return r.error;
  const s = JSON.stringify(r.data, null, 2);
  return s.length <= max ? s : s.slice(0, max) + '\n... [截断]';
}
