/**
 * 配置管理 — 读写 ~/.feishu-cc-agent/config.json
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
    baseUrl: string;    // OpenAI 兼容 API 端点
    apiKey: string;
    model: string;
    maxTurns: number;   // Agent 最大工具调用轮数
    timeoutMs: number;  // Agent 单次超时
  };
  permissions: {
    adminOpenIds: string[];  // 管理员飞书 open_id
  };
  claudeCode: {
    enabled: boolean;
    skipPermissions: boolean;  // --dangerously-skip-permissions
    resumeSession: boolean;   // --continue
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
  claudeCode: { enabled: true, skipPermissions: true, resumeSession: true },
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...raw };
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
