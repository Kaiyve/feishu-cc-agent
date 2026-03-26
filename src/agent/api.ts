/**
 * AI Agent API — Provider-adaptive OpenAI-compatible client
 *
 * Handles the reality that "OpenAI compatible" means different things:
 * - Tool call format differences (tool_calls vs function_call)
 * - Tool call ID requirements (Mistral needs 9-char alphanumeric)
 * - Strict mode / developer role (only native OpenAI)
 * - Providers that don't support tool calling at all
 * - Retry with error classification (rate limit, overload, network)
 *
 * Inspired by OpenClaw's provider capability system, simplified for
 * a lightweight project that doesn't need a full plugin architecture.
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

// ═══ Provider Compat Detection ═══

interface ProviderCompat {
  supportsTools: boolean;
  needsStrictToolIds: boolean;   // Mistral: 9-char alphanumeric IDs
  maxTokensField: string;        // 'max_tokens' or 'max_completion_tokens'
  handleLegacyFunctionCall: boolean;  // Some providers use old function_call format
}

const PROVIDER_HINTS: Record<string, Partial<ProviderCompat>> = {
  'api.mistral.ai':       { needsStrictToolIds: true },
  'codestral.mistral.ai': { needsStrictToolIds: true },
  'api.openai.com':       { maxTokensField: 'max_tokens' },
  'generativelanguage.googleapis.com': { supportsTools: true },
  'api.deepseek.com':     { supportsTools: true },
  'open.bigmodel.cn':     { supportsTools: true },  // ZhiPu GLM
  'openrouter.ai':        { supportsTools: true },
  'api.together.xyz':     { supportsTools: true },
  'api.groq.com':         { supportsTools: true },
};

// Models known to NOT support tool calling
const NO_TOOL_MODELS = [
  'o1-mini', 'o1-preview',  // OpenAI reasoning models (old)
  'deepseek-reasoner',      // DeepSeek R1 reasoning
];

function detectCompat(baseUrl: string, model: string): ProviderCompat {
  const defaults: ProviderCompat = {
    supportsTools: true,
    needsStrictToolIds: false,
    maxTokensField: 'max_tokens',
    handleLegacyFunctionCall: true,
  };

  // Check model-level overrides
  const modelLower = model.toLowerCase();
  if (NO_TOOL_MODELS.some(m => modelLower.includes(m))) {
    defaults.supportsTools = false;
  }

  // Check provider-level hints
  try {
    const host = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`).hostname;
    for (const [pattern, compat] of Object.entries(PROVIDER_HINTS)) {
      if (host.includes(pattern)) {
        return { ...defaults, ...compat };
      }
    }
  } catch { /* invalid URL, use defaults */ }

  return defaults;
}

// ═══ Tool Call ID Sanitization ═══

let idCounter = 0;

function sanitizeToolCallId(id: string | undefined, strict: boolean): string {
  if (!id) return `call_${(++idCounter).toString(36).padStart(6, '0')}`;
  if (!strict) return id;
  // Mistral: 9-char alphanumeric only
  const clean = id.replace(/[^a-zA-Z0-9]/g, '');
  return clean.slice(0, 9) || `tc${(++idCounter).toString(36).padStart(7, '0')}`;
}

// ═══ Error Classification ═══

type ErrorClass = 'rate_limit' | 'overloaded' | 'auth' | 'network' | 'context_overflow' | 'unknown';

function classifyError(status: number, body: string): ErrorClass {
  if (status === 429) return 'rate_limit';
  if (status === 503 || status === 502) return 'overloaded';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 && (body.includes('context') || body.includes('token') || body.includes('length'))) return 'context_overflow';
  return 'unknown';
}

function getRetryDelay(errorClass: ErrorClass, attempt: number): number | null {
  switch (errorClass) {
    case 'rate_limit':   return Math.min(2000 * Math.pow(2, attempt), 30000); // 2s, 4s, 8s... max 30s
    case 'overloaded':   return 3000 * (attempt + 1); // 3s, 6s, 9s
    case 'network':      return 1000 * (attempt + 1); // 1s, 2s, 3s
    case 'auth':         return null; // Don't retry auth errors
    case 'context_overflow': return null; // Don't retry, need to reduce input
    default:             return attempt === 0 ? 2000 : null; // One retry for unknown
  }
}

// ═══ Tool Calling Fallback ═══

/**
 * When a provider doesn't support tools, bake tool descriptions into the system prompt
 * and parse the model's text response for tool calls in a simple JSON format.
 */
function buildToolFallbackPrompt(system: string, tools: ToolDefinition[]): string {
  if (tools.length === 0) return system;

  const toolDescriptions = tools.map(t =>
    `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.input_schema)}`
  ).join('\n');

  return `${system}

---

## Available Tools
You have access to the following tools. To call a tool, respond with a JSON block:
\`\`\`json
{"tool": "tool_name", "input": {... parameters ...}}
\`\`\`

Tools:
${toolDescriptions}

If you don't need to call a tool, respond normally without any JSON block.`;
}

function parseToolCallsFromText(text: string): ToolCall[] | null {
  // Look for ```json { "tool": "...", "input": {...} } ``` blocks
  const jsonBlockRegex = /```json\s*\n?([\s\S]*?)\n?\s*```/g;
  const calls: ToolCall[] = [];

  let match;
  while ((match = jsonBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({
          id: `fallback_${(++idCounter).toString(36)}`,
          name: parsed.tool,
          input: parsed.input || parsed.parameters || {},
        });
      }
    } catch { /* not valid JSON, skip */ }
  }

  return calls.length > 0 ? calls : null;
}

// ═══ Main API Call ═══

const MAX_RETRIES = 2;

/**
 * Full agent call with tool support, provider adaptation, and retry logic.
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
  const compat = detectCompat(baseUrl, model);
  const url = buildUrl(baseUrl);

  // If tools not supported, fall back to text-based tool calling
  const useToolFallback = !compat.supportsTools && tools.length > 0;

  const body: any = {
    model,
    messages: [
      { role: 'system', content: useToolFallback ? buildToolFallbackPrompt(system, tools) : system },
      ...messages,
    ],
    [compat.maxTokensField]: 4096,
  };

  // Only include tools in the payload if provider supports them
  if (tools.length > 0 && !useToolFallback) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  // Retry loop with error classification
  let lastError: Error | null = null;
  let toolCallFailed = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && lastError) {
      const errBody = lastError.message;
      const status = parseInt(errBody.match(/\d{3}/)?.[0] || '0');
      const errClass = status ? classifyError(status, errBody) : 'network';
      const delay = getRetryDelay(errClass, attempt - 1);

      if (delay === null) throw lastError; // Non-retryable
      console.log(`  ⏳ Retry ${attempt}/${MAX_RETRIES} (${errClass}, wait ${delay}ms)`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      // If previous attempt failed on tool calling, retry without tools
      const retryBody = (toolCallFailed && !useToolFallback)
        ? { ...body, tools: undefined, messages: [
            { role: 'system', content: buildToolFallbackPrompt(system, tools) },
            ...messages,
          ]}
        : body;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(retryBody),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const errClass = classifyError(res.status, errBody);

        // Detect tool-calling-specific failures (400 with tool-related error)
        if (res.status === 400 && tools.length > 0 && !useToolFallback &&
            (errBody.includes('tool') || errBody.includes('function') || errBody.includes('unsupported'))) {
          console.log('  ⚠️ Tool calling rejected by provider, falling back to text mode');
          toolCallFailed = true;
          lastError = new Error(`AI API ${res.status}: ${errBody.slice(0, 200)}`);
          continue;
        }

        lastError = new Error(`AI API ${res.status}: ${errBody.slice(0, 200)}`);
        continue;
      }

      const data = await res.json() as any;
      return parseResponse(data, compat, useToolFallback || toolCallFailed);

    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        lastError = new Error('AI API timeout (60s)');
        continue;
      }
      if (err.message?.includes('fetch failed') || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
        lastError = new Error(`Network error: ${err.message}`);
        continue;
      }
      throw err; // Unknown error, don't retry
    }
  }

  throw lastError || new Error('AI API failed after retries');
}

// ═══ Response Parsing ═══

function parseResponse(data: any, compat: ProviderCompat, textToolFallback: boolean): AgentResponse {
  const choice = data.choices?.[0];
  const msg = choice?.message;
  const text = msg?.content ?? null;

  // 1. Check for native tool_calls (OpenAI format)
  let toolCalls: ToolCall[] | null = null;

  if (msg?.tool_calls?.length) {
    toolCalls = msg.tool_calls.map((tc: any) => {
      let input: Record<string, any> = {};
      try {
        let args = tc.function?.arguments || '{}';
        // xAI HTML entity decoding
        if (args.includes('&quot;') || args.includes('&amp;')) {
          args = args.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        }
        input = JSON.parse(args);
      } catch { input = {}; }

      return {
        id: sanitizeToolCallId(tc.id, compat.needsStrictToolIds),
        name: tc.function?.name || 'unknown',
        input,
      };
    });
  }

  // 2. Check for legacy function_call format (older OpenAI, some proxies)
  if (!toolCalls && compat.handleLegacyFunctionCall && msg?.function_call) {
    let input: Record<string, any> = {};
    try { input = JSON.parse(msg.function_call.arguments || '{}'); } catch { input = {}; }
    toolCalls = [{
      id: sanitizeToolCallId(undefined, compat.needsStrictToolIds),
      name: msg.function_call.name,
      input,
    }];
  }

  // 3. Text fallback: parse tool calls from text response
  if (!toolCalls && textToolFallback && text) {
    toolCalls = parseToolCallsFromText(text);
  }

  // Determine stop reason
  const finishReason = choice?.finish_reason;
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens';

  if (toolCalls && toolCalls.length > 0) {
    stopReason = 'tool_use';
  } else if (finishReason === 'tool_calls' || finishReason === 'function_call') {
    stopReason = 'tool_use';
  } else if (finishReason === 'length') {
    stopReason = 'max_tokens';
  } else {
    stopReason = 'end_turn';
  }

  return { text, toolCalls, stopReason };
}

// ═══ Lightweight Call (no tools, for background tasks) ═══

/**
 * Low-token, short-timeout LLM call for memory extraction and summarization.
 * Single retry on transient errors.
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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
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
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        if (res.status === 429 || res.status === 503) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw new Error(`AI API ${res.status}`);
      }

      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content ?? '';
    } catch (err: any) {
      if (attempt === 0 && (err.name === 'TimeoutError' || err.message?.includes('fetch failed'))) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }

  throw new Error('Lightweight LLM call failed after retry');
}

// ═══ Helpers ═══

function buildUrl(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}
