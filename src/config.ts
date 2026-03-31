/**
 * Config management — read/write ~/.feishu-cc-agent/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
  };
  agent: {
    baseUrl: string;    // OpenAI-compatible API endpoint
    apiKey: string;
    model: string;
    maxTurns: number;   // Max tool-call rounds per message
    timeoutMs: number;  // Total timeout per message
  };
  permissions: {
    adminOpenIds: string[];  // Admin Feishu open_ids
  };
  claudeCode: {
    enabled: boolean;
    skipPermissions: boolean;  // --dangerously-skip-permissions (⚠️ bypasses ALL safety prompts)
    resultDelivery: 'private' | 'source';  // 'private' = DM admin, 'source' = reply to trigger chat
    taskTimeoutMin: number;   // task timeout in minutes (default 60)
  };
}

const CONFIG_DIR = resolve(homedir(), '.feishu-cc-agent');
const CONFIG_FILE = resolve(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: Config = {
  feishu: { appId: '', appSecret: '' },
  agent: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    maxTurns: 10,
    timeoutMs: 120_000,
  },
  permissions: { adminOpenIds: [] },
  claudeCode: { enabled: true, skipPermissions: true, resultDelivery: 'private', taskTimeoutMin: 60 },
};

/**
 * Deep merge: preserves nested defaults when user config only overrides some fields.
 * Fix #7: shallow merge was dropping maxTurns/timeoutMs when user only set apiKey.
 */
function deepMerge<T extends Record<string, any>>(defaults: T, override: Record<string, any>): T {
  const result = { ...defaults };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (
      val !== null && typeof val === 'object' && !Array.isArray(val)
      && key in defaults && typeof (defaults as any)[key] === 'object' && !Array.isArray((defaults as any)[key])
    ) {
      (result as any)[key] = deepMerge((defaults as any)[key], val);
    } else {
      (result as any)[key] = val;
    }
  }
  return result;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return deepMerge(DEFAULT_CONFIG, raw);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function isConfigured(): boolean {
  const config = loadConfig();
  return !!(config.feishu.appId && config.feishu.appSecret && config.agent.apiKey);
}

export { CONFIG_DIR, CONFIG_FILE };
