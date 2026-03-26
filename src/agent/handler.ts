/**
 * Agent Handler — Agentic Loop + Auto Memory Extraction
 *
 * Flow: message → load context (history + summaries + memories) → AI reasoning → tool loop → reply
 * Post-reply: auto-extract memories + compress old turns into summaries
 */

import { callAgent, callLightweight, type AgentMessage, type ToolCall } from './api.js';
import { AGENT_TOOLS, executeToolSafely, truncateResult, type ToolContext } from './tools.js';
import { buildSystemPrompt } from './prompts.js';
import {
  loadHistory, saveHistory, searchMemories, getRecentMemories,
  loadSummaries, saveSummary, getOldTurns, deleteOldTurns,
  saveMemory, getMemoryCount,
} from '../memory/store.js';
import type { Config } from '../config.js';
import chalk from 'chalk';

// ═══ Concurrency Control ═══

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

  // Load context: history + summaries + memories
  const history = loadHistory(chatId, senderOpenId, 10);
  const summaries = loadSummaries(chatId, senderOpenId, 2);
  const searchedMemories = searchMemories(userMessage, chatId, senderOpenId);
  const recentMemories = getRecentMemories(senderOpenId, 5);

  // Merge & deduplicate memories (searched + recent)
  const memoryMap = new Map<string, { key: string; content: string; type: string }>();
  for (const m of recentMemories) memoryMap.set(m.key, m);
  for (const m of searchedMemories) memoryMap.set(m.key, m); // searched overrides recent
  const allMemories = [...memoryMap.values()];

  const systemPrompt = buildSystemPrompt({
    memories: allMemories,
    summaries: summaries.map(s => s.summary),
    chatId,
    senderOpenId,
    isAdmin,
  });

  const toolCtx: ToolContext = { chatId, senderOpenId, isAdmin, config };

  // Build messages
  const messages: AgentMessage[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: userMessage },
  ];

  let rounds = 0;

  while (rounds < config.agent.maxTurns) {
    if (Date.now() - startTime > config.agent.timeoutMs) {
      return 'Timeout. Please narrow your question.';
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
      const text = response.text || '(no reply)';
      saveHistory(chatId, senderOpenId, userMessage, text);

      // Post-reply: auto-extract memories & compress history (fire-and-forget)
      autoExtractMemories(userMessage, text, senderOpenId, config).catch(() => {});
      autoCompressHistory(chatId, senderOpenId, config).catch(() => {});

      return text;
    }

    // Execute tools
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

  return `Max reasoning rounds reached (${config.agent.maxTurns}).`;
}

// ═══ Auto Memory Extraction ═══

const EXTRACT_PROMPT = `You are a memory extraction module. Given a user message and assistant reply, extract key facts worth remembering for future conversations.

Rules:
- Only extract information that would be useful in FUTURE conversations
- Focus on: user preferences, project details, technical decisions, personal facts, recurring topics
- Skip: greetings, generic questions, one-time requests, information already obvious from context
- If nothing is worth remembering, return an empty array
- Each memory needs a short key (identifier) and content (the fact)

Respond with a JSON array (no markdown, no explanation):
[{"key": "short-key", "content": "the fact to remember", "type": "preference|fact|insight"}]

Or if nothing to extract:
[]`;

async function autoExtractMemories(
  userMessage: string,
  assistantReply: string,
  senderOpenId: string,
  config: Config,
) {
  // Skip extraction for very short exchanges
  if (userMessage.length < 10 && assistantReply.length < 50) return;

  // Don't accumulate too many auto-extracted memories
  const count = getMemoryCount(senderOpenId);
  if (count > 200) return;

  try {
    const input = `User: ${userMessage.slice(0, 500)}\nAssistant: ${assistantReply.slice(0, 500)}`;
    const result = await callLightweight({
      baseUrl: config.agent.baseUrl,
      apiKey: config.agent.apiKey,
      model: config.agent.model,
      system: EXTRACT_PROMPT,
      message: input,
    });

    // Parse JSON array from response
    const text = result.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const items = JSON.parse(jsonMatch[0]) as Array<{ key: string; content: string; type: string }>;
    if (!Array.isArray(items) || items.length === 0) return;

    for (const item of items.slice(0, 3)) {
      if (item.key && item.content && item.key.length <= 100 && item.content.length <= 500) {
        saveMemory(item.key, item.content, item.type || 'fact', senderOpenId, 'auto');
        console.log(chalk.gray(`  💾 Auto-memory: [${item.type}] ${item.key}`));
      }
    }
  } catch (err: any) {
    // Silent failure — memory extraction is best-effort
    console.log(chalk.gray(`  ⚠️ Memory extraction skipped: ${err.message?.slice(0, 60)}`));
  }
}

// ═══ Auto Compress History ═══

const SUMMARIZE_PROMPT = `You are a conversation summarizer. Compress the following conversation turns into a concise summary that preserves:
- Key decisions made
- Important facts mentioned
- User preferences expressed
- Tasks discussed or completed
- Technical context that might be needed later

Write a dense paragraph (100-200 words). Reply in the same language as the conversation. No preamble, just the summary.`;

async function autoCompressHistory(
  chatId: string,
  senderOpenId: string,
  config: Config,
) {
  // Only compress when history exceeds 20 turns (40 messages)
  const oldTurns = getOldTurns(chatId, senderOpenId, 20);
  if (oldTurns.length < 10) return; // At least 10 messages worth compressing

  try {
    const conversation = oldTurns
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');

    const summary = await callLightweight({
      baseUrl: config.agent.baseUrl,
      apiKey: config.agent.apiKey,
      model: config.agent.model,
      system: SUMMARIZE_PROMPT,
      message: conversation.slice(0, 3000),
    });

    if (summary && summary.length > 20) {
      saveSummary(chatId, senderOpenId, summary, oldTurns.length);
      deleteOldTurns(oldTurns.map(t => t.id));
      console.log(chalk.gray(`  📦 Compressed ${oldTurns.length} turns → summary (${summary.length} chars)`));
    }
  } catch (err: any) {
    console.log(chalk.gray(`  ⚠️ History compression skipped: ${err.message?.slice(0, 60)}`));
  }
}

// ═══ Main Entry ═══

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
        resolve(`AI service error: ${err.message}`);
      }
    });
  });
}
