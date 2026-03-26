/**
 * AI Agent API — Any OpenAI-compatible endpoint
 *
 * Supports: ZhiPu, DeepSeek, LiteLLM, OpenRouter, OpenAI, etc.
 */

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface AgentResponse {
  text: string | null;
  toolCalls: ToolCall[] | null;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

/**
 * Full agent call with tool support.
 */
export async function callAgent(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
}): Promise<AgentResponse> {
  const { baseUrl, apiKey, model, system, messages, tools } = params;

  const body: any = {
    model,
    messages: [
      { role: 'system', content: system },
      ...messages,
    ],
    max_tokens: 4096,
  };

  if (tools.length > 0) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  const url = buildUrl(baseUrl);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`AI API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const choice = data.choices?.[0];
  const msg = choice?.message;

  let toolCalls: ToolCall[] | null = null;
  if (msg?.tool_calls?.length) {
    toolCalls = msg.tool_calls.map((tc: any) => {
      let input: Record<string, any> = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
      return { id: tc.id, name: tc.function.name, input };
    });
  }

  return {
    text: msg?.content ?? null,
    toolCalls,
    stopReason: choice?.finish_reason === 'tool_calls' ? 'tool_use'
      : choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
  };
}

/**
 * Lightweight LLM call — no tools, low max_tokens, short timeout.
 * Used for memory extraction and conversation summarization.
 */
export async function callLightweight(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  message: string;
}): Promise<string> {
  const { baseUrl, apiKey, model, system, message } = params;

  const url = buildUrl(baseUrl);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message },
      ],
      max_tokens: 512,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(15_000), // Short timeout for background tasks
  });

  if (!res.ok) {
    throw new Error(`AI API ${res.status}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? '';
}

function buildUrl(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}
