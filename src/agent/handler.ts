/**
 * Agent Handler — Agentic Loop
 *
 * 消息 → 加载上下文 → AI 推理 → 工具调用循环 → 回复
 */

import { callAgent, type AgentMessage, type ToolCall } from './api.js';
import { AGENT_TOOLS, executeToolSafely, truncateResult, type ToolContext } from './tools.js';
import { buildSystemPrompt } from './prompts.js';
import { loadHistory, saveHistory, searchMemories } from '../memory/store.js';
import type { Config } from '../config.js';

// ═══ 并发控制 ═══

const queues = new Map<string, Promise<void>>();

function enqueue(key: string, fn: () => Promise<void>) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.catch(() => {}).finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

// ═══ Agentic Loop ═══

async function agenticLoop(
  userMessage: string,
  chatId: string,
  senderOpenId: string,
  config: Config,
): Promise<string> {
  const startTime = Date.now();
  const isAdmin = config.permissions.adminOpenIds.includes(senderOpenId);

  // 加载上下文
  const history = loadHistory(chatId, senderOpenId, 10);
  const memories = searchMemories(userMessage, chatId, senderOpenId);
  const systemPrompt = buildSystemPrompt({ memories, chatId, senderOpenId, isAdmin });

  const toolCtx: ToolContext = { chatId, senderOpenId, isAdmin, config };

  // 构建消息
  const messages: AgentMessage[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: userMessage },
  ];

  let rounds = 0;

  while (rounds < config.agent.maxTurns) {
    if (Date.now() - startTime > config.agent.timeoutMs) {
      return '分析超时，请缩小问题范围。';
    }

    const response = await callAgent({
      baseUrl: config.agent.baseUrl,
      apiKey: config.agent.apiKey,
      model: config.agent.model,
      system: systemPrompt,
      messages,
      tools: AGENT_TOOLS,
    });

    if (response.stopReason !== 'tool_use' || !response.toolCalls?.length) {
      const text = response.text || '（无回复）';
      saveHistory(chatId, senderOpenId, userMessage, text);
      return text;
    }

    // 执行工具
    for (const call of response.toolCalls) {
      console.log(`  🔧 ${call.name}(${JSON.stringify(call.input).slice(0, 80)})`);
      const result = await executeToolSafely(call.name, call.input, toolCtx);
      const content = truncateResult(result);

      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }],
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }

    rounds++;
  }

  return `已达最大推理轮数（${config.agent.maxTurns}）。`;
}

// ═══ 主入口 ═══

export async function handleMessage(
  userMessage: string,
  chatId: string,
  senderOpenId: string,
  config: Config,
): Promise<string> {
  return new Promise((resolve) => {
    enqueue(`${chatId}:${senderOpenId}`, async () => {
      try {
        const reply = await agenticLoop(userMessage, chatId, senderOpenId, config);
        resolve(reply);
      } catch (err: any) {
        console.error('Agent error:', err.message);
        resolve(`AI 服务异常: ${err.message}`);
      }
    });
  });
}
