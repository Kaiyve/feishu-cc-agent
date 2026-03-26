<div align="right">
  <a href="#english">English</a> | 中文
</div>

# feishu-cc-agent

手机飞书，用上最强通用 Agent。

飞书原本能发消息，但缺少 AI 推理和本地执行能力。这个项目补上的是：**智能 Agent 路由 + 本地 Claude Code 执行 + 跨会话记忆**。

---

## 能力

| 能力 | 说明 |
|------|------|
| 智能路由 | 简单问题 Agent 直答，复杂任务自动委派 Claude Code |
| 本地执行 | 飞书发消息 → Mac 上的 Claude Code 干活 → 结果推回飞书 |
| 跨会话记忆 | FTS5 全文搜索 + 自动提取事实 + 历史对话压缩，不是一次性聊天 |
| 任意 AI 提供商 | 智谱 / DeepSeek / OpenRouter / Ollama / OpenAI，自动适配 tool calling 差异 |
| 任务持久化 | Claude Code 任务队列存 SQLite，进程重启自动恢复 |
| 权限分级 | 管理员可执行 Claude Code、写全局记忆；普通用户仅对话 |

## 安装

**前提**：Node.js ≥ 20，[Claude Code](https://claude.ai/download) 已安装，飞书开放平台应用（[配置指南](#飞书应用配置)）

```bash
npm install -g feishu-cc-agent
```

## 配置 → 启动

```bash
feishu-cc-agent init    # 交互式向导：飞书 App → AI API → Claude Code → 管理员
feishu-cc-agent start   # 启动，去飞书发消息试试
```

## 使用

安装后直接在飞书给机器人发消息，Agent 自动判断怎么处理：

- "帮我解释一下 React hooks" → Agent 直接回答
- "帮我改一下登录页的样式" → 委派给 Claude Code
- "记住我喜欢用 TypeScript" → 保存到本地记忆
- "帮我跑一下测试" → Claude Code 执行，结果推回飞书

## AI 提供商

| 提供商 | Base URL | 推荐模型 |
|-------|----------|---------|
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |

任何 OpenAI 兼容端点都支持。不支持 tool calling 的模型会自动降级为文本模式。

## 飞书应用配置

1. [飞书开放平台](https://open.feishu.cn) → 创建企业自建应用 → 添加**机器人**能力
2. 权限：`im:message` + `im:message:send_as_bot`
3. 事件订阅：**长连接模式** + `im.message.receive_v1`
4. 发布版本

<details>
<summary>配置文件参考</summary>

`~/.feishu-cc-agent/config.json`：

```json
{
  "feishu": { "appId": "cli_xxx", "appSecret": "xxx" },
  "agent": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "xxx",
    "model": "glm-4-plus",
    "maxTurns": 10,
    "timeoutMs": 120000
  },
  "permissions": { "adminOpenIds": ["ou_xxx"] },
  "claudeCode": { "enabled": true, "skipPermissions": true }
}
```

</details>

<details>
<summary>架构</summary>

```
┌────────────────────────────────────────────────┐
│            feishu-cc-agent (Local Mac)          │
│                                                │
│  📱 飞书 WebSocket ← @larksuiteoapi/node-sdk   │
│       ↓                                        │
│  🧠 Agent (任意 OpenAI 兼容 API)                │
│       ↓ 智能路由                                │
│  ┌─ 简单问题 → Agent 直接回答                   │
│  └─ 复杂任务 → Claude Code (本地执行)           │
│                                                │
│  💾 SQLite (记忆 + 任务队列，零配置)             │
└────────────────────────────────────────────────┘
```

</details>

## 开发

```bash
git clone https://github.com/Kaiyve/feishu-cc-agent.git
cd feishu-cc-agent && npm install
npm run dev -- start
```

## 设计哲学

> Agent 不是转发器。它有记忆、有判断、知道什么自己能做、什么该交给 Claude Code。
> 记忆不靠用户手动保存——每轮对话自动提取事实，老对话自动压缩成摘要，搜索用 FTS5 不用 LIKE。

## License

MIT

## 致谢

- [Claude Code](https://claude.ai/download) — Anthropic
- [@larksuiteoapi/node-sdk](https://github.com/larksuite/oapi-sdk-nodejs) — 飞书 SDK
- [OpenClaw](https://github.com/openclaw/openclaw) — 记忆架构 & API 兼容性参考

---

<a id="english"></a>

<div align="right">
  <a href="#feishu-cc-agent">中文</a> | English
</div>

# feishu-cc-agent

The most powerful general-purpose Agent, on your phone via Feishu.

Feishu can send messages, but lacks AI reasoning and local execution. This project adds: **smart Agent routing + local Claude Code execution + cross-session memory**.

---

## Capabilities

| Capability | Description |
|-----------|-------------|
| Smart Routing | Simple questions answered by Agent, complex tasks auto-delegated to Claude Code |
| Local Execution | Send message on Feishu → Claude Code works on your Mac → result pushed back |
| Cross-session Memory | FTS5 full-text search + auto fact extraction + conversation compression |
| Any AI Provider | ZhiPu / DeepSeek / OpenRouter / Ollama / OpenAI, auto-adapts tool calling differences |
| Task Persistence | Claude Code task queue in SQLite, auto-recovers on restart |
| Permission Control | Admins can run Claude Code + write global memories; regular users chat only |

## Install

**Prerequisites**: Node.js ≥ 20, [Claude Code](https://claude.ai/download) installed, Feishu app ([Setup Guide](#feishu-app-setup))

```bash
npm install -g feishu-cc-agent
```

## Configure → Start

```bash
feishu-cc-agent init    # Interactive wizard: Feishu App → AI API → Claude Code → Admin
feishu-cc-agent start   # Start, then message your bot on Feishu
```

## Usage

Just message your bot on Feishu. The Agent decides how to handle it:

- "Explain React hooks" → Agent answers directly
- "Fix the login page styles" → Delegates to Claude Code
- "Remember I prefer TypeScript" → Saves to local memory
- "Run the tests" → Claude Code executes, result pushed back to Feishu

## AI Providers

| Provider | Base URL | Recommended Model |
|----------|----------|-------------------|
| ZhiPu | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |

Any OpenAI-compatible endpoint works. Models without tool calling auto-fallback to text mode.

## Feishu App Setup

1. [Feishu Open Platform](https://open.feishu.cn) → Create internal app → Add **Bot** capability
2. Permissions: `im:message` + `im:message:send_as_bot`
3. Events: **Long connection** + `im.message.receive_v1`
4. Publish a version

<details>
<summary>Config reference</summary>

`~/.feishu-cc-agent/config.json`:

```json
{
  "feishu": { "appId": "cli_xxx", "appSecret": "xxx" },
  "agent": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "xxx",
    "model": "glm-4-plus",
    "maxTurns": 10,
    "timeoutMs": 120000
  },
  "permissions": { "adminOpenIds": ["ou_xxx"] },
  "claudeCode": { "enabled": true, "skipPermissions": true }
}
```

</details>

<details>
<summary>Architecture</summary>

```
┌────────────────────────────────────────────────┐
│            feishu-cc-agent (Local Mac)          │
│                                                │
│  📱 Feishu WebSocket ← @larksuiteoapi/node-sdk │
│       ↓                                        │
│  🧠 Agent (Any OpenAI-compatible API)          │
│       ↓ Smart routing                          │
│  ┌─ Simple questions → Agent answers directly  │
│  └─ Complex tasks → Claude Code (local exec)   │
│                                                │
│  💾 SQLite (Memory + Task Queue, zero config)  │
└────────────────────────────────────────────────┘
```

</details>

## Development

```bash
git clone https://github.com/Kaiyve/feishu-cc-agent.git
cd feishu-cc-agent && npm install
npm run dev -- start
```

## Design Philosophy

> An Agent is not a forwarder. It has memory, judgment, and knows what to handle itself vs. what to delegate.
> Memory doesn't rely on manual saves — facts are auto-extracted after each turn, old conversations are compressed into summaries, search uses FTS5 not LIKE.

## License

MIT

## Acknowledgments

- [Claude Code](https://claude.ai/download) — Anthropic
- [@larksuiteoapi/node-sdk](https://github.com/larksuite/oapi-sdk-nodejs) — Feishu SDK
- [OpenClaw](https://github.com/openclaw/openclaw) — Memory architecture & API compat reference
