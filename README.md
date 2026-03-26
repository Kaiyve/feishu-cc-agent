# feishu-cc-agent

手机飞书，用上最强通用 Agent

> 在飞书上发消息，AI Agent 理解你的意图，简单问题直接回答，复杂任务自动交给本地 Mac 上的 Claude Code 执行。

[English](#english) | 中文

## 🔥 为什么用这个？

**1. Agent 有记忆，不是一次性对话**

普通 Bot 每次对话都从零开始。feishu-cc-agent 的 Agent 有完整的记忆系统——它记得你的偏好、之前聊过的内容、你关心的项目。你说"上次那个 bug 修好了吗"，它知道你在说什么。

**2. 手机上操控本地 Mac 的 Claude Code**

在地铁上、在床上、在任何地方，打开飞书发一句"帮我把登录页的样式改一下"，你 Mac 上的 Claude Code 就开始干活了。干完自动把结果推回飞书。任务队列持久化在 SQLite 中，进程重启后自动恢复未完成的任务。

## ✨ 特性

- **飞书原生** — WebSocket 长连接，支持群聊和私聊
- **智能 Agent** — 不是简单转发，能理解意图、智能路由
- **Claude Code 集成** — 复杂任务自动委派到本地 Mac 执行
- **任意 AI 提供商** — 支持智谱、DeepSeek、OpenRouter、LiteLLM 等
- **本地记忆** — SQLite 存储，零服务器、零配置
- **自动部署 Skills** — 安装时自动配置 Claude Code 技能

## 🚀 快速开始

### 前提

- Node.js ≥ 20
- [Claude Code](https://claude.ai/download) 已安装（如需本地执行功能）
- 飞书开放平台应用（[创建指南](#-飞书应用配置)）
- 任意 OpenAI 兼容 AI API Key

### 安装

```bash
npm install -g feishu-cc-agent
```

### 配置

```bash
feishu-cc-agent init
```

交互式向导会引导你配置：
1. 📱 飞书 App ID / Secret
2. 🧠 AI API（从预设列表选择或自定义）
3. 💻 Claude Code（是否启用本地执行）
4. 🔐 管理员 open_id

### 启动

```bash
feishu-cc-agent start
```

就这样！去飞书给你的机器人发消息试试。

## 💬 使用示例

| 你说的 | Agent 做的 |
|-------|-----------|
| "帮我解释一下 React hooks" | Agent 直接回答 |
| "帮我改一下项目的登录页面" | 委派给 Claude Code 执行 |
| "帮我跑一下项目的测试" | 委派给 Claude Code 执行 |
| "记住我喜欢用 TypeScript" | 保存到本地记忆 |

## 🤖 支持的 AI 提供商

| 提供商 | Base URL | 推荐模型 |
|-------|----------|---------|
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| LiteLLM | 自定义 | 自定义 |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |

只要是 OpenAI 兼容的 `/chat/completions` 端点都支持。

## 📱 飞书应用配置

1. 登录 [飞书开放平台](https://open.feishu.cn)
2. 创建企业自建应用
3. 添加**机器人**能力
4. 权限管理 → 开启:
   - `im:message`（获取与发送消息）
   - `im:message:send_as_bot`（以应用身份发消息）
5. 事件与回调 → 订阅方式: **使用长连接接收事件**
6. 添加事件: `im.message.receive_v1`
7. 版本管理 → 创建版本 → 发布

## ⚙️ 配置文件

配置保存在 `~/.feishu-cc-agent/config.json`：

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx"
  },
  "agent": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "xxx",
    "model": "glm-4-plus",
    "maxTurns": 10,
    "timeoutMs": 120000
  },
  "permissions": {
    "adminOpenIds": ["ou_xxx"]
  },
  "claudeCode": {
    "enabled": true,
    "skipPermissions": true
  }
}
```

## 🏗️ 架构

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
│  💾 SQLite Memory (local file, zero config)    │
│  📦 Auto-deployed Skills                       │
└────────────────────────────────────────────────┘
```

## 🔧 开发

```bash
git clone https://github.com/Kaiyve/feishu-cc-agent.git
cd feishu-cc-agent
npm install
npm run dev -- start
```

## 📄 License

MIT

## 🙏 致谢

- [Claude Code](https://claude.ai/download) — Anthropic
- [@larksuiteoapi/node-sdk](https://github.com/larksuite/oapi-sdk-nodejs) — Feishu SDK
- [OpenClaw](https://github.com/openclaw/openclaw) — Memory architecture inspiration

---

<a id="english"></a>

# feishu-cc-agent

The most powerful general-purpose Agent, right on your phone via Feishu

> Send a message on Feishu, AI Agent understands your intent, answers simple questions directly, and automatically delegates complex tasks to Claude Code running on your local Mac.

## 🔥 Why This?

**1. Agent with Memory — Not a Disposable Chat**

Normal bots start from scratch every time. feishu-cc-agent has a full memory system — it remembers your preferences, past conversations, and projects you care about. Say "is that bug from last time fixed?" and it knows exactly what you're talking about.

**2. Control Your Local Mac's Claude Code from Your Phone**

On the subway, in bed, anywhere — open Feishu and say "fix the login page styles". Claude Code on your Mac starts working immediately and pushes the result back to Feishu when done. The task queue is persisted to SQLite, so pending tasks survive process restarts.

## ✨ Features

- **Feishu Native** — WebSocket long connection, supports group and private chats
- **Smart Agent** — Not a simple forwarder; understands intent and routes intelligently
- **Claude Code Integration** — Complex tasks auto-delegated to your local Mac
- **Any AI Provider** — Supports ZhiPu, DeepSeek, OpenRouter, LiteLLM, and more
- **Local Memory** — SQLite storage, zero servers, zero configuration
- **Auto-deploy Skills** — Automatically configures Claude Code skills on install

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 20
- [Claude Code](https://claude.ai/download) installed (for local execution)
- A Feishu Open Platform app ([Setup Guide](#-feishu-app-setup))
- Any OpenAI-compatible AI API Key

### Install

```bash
npm install -g feishu-cc-agent
```

### Configure

```bash
feishu-cc-agent init
```

The interactive wizard will guide you through:
1. 📱 Feishu App ID / Secret
2. 🧠 AI API (choose from presets or custom)
3. 💻 Claude Code (enable local execution or not)
4. 🔐 Admin open_id

### Start

```bash
feishu-cc-agent start
```

That's it! Go send a message to your bot on Feishu.

## 💬 Usage Examples

| You say | Agent does |
|---------|-----------|
| "Explain React hooks to me" | Agent answers directly |
| "Help me fix the login page" | Delegates to Claude Code |
| "Run the project tests for me" | Delegates to Claude Code |
| "Remember that I prefer TypeScript" | Saves to local memory |

## 🤖 Supported AI Providers

| Provider | Base URL | Recommended Model |
|----------|----------|-------------------|
| ZhiPu | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| LiteLLM | Custom | Custom |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |

Any OpenAI-compatible `/chat/completions` endpoint is supported.

## 📱 Feishu App Setup

1. Log in to [Feishu Open Platform](https://open.feishu.cn)
2. Create an internal enterprise app
3. Add **Bot** capability
4. Permissions → Enable:
   - `im:message` (read & send messages)
   - `im:message:send_as_bot` (send messages as bot)
5. Events & Callbacks → Subscription method: **Long connection**
6. Add event: `im.message.receive_v1`
7. Version Management → Create version → Publish

## ⚙️ Configuration

Config is stored at `~/.feishu-cc-agent/config.json`:

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx"
  },
  "agent": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "xxx",
    "model": "glm-4-plus",
    "maxTurns": 10,
    "timeoutMs": 120000
  },
  "permissions": {
    "adminOpenIds": ["ou_xxx"]
  },
  "claudeCode": {
    "enabled": true,
    "skipPermissions": true
  }
}
```

## 🏗️ Architecture

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
│  💾 SQLite Memory (local file, zero config)    │
│  📦 Auto-deployed Skills                       │
└────────────────────────────────────────────────┘
```

## 🔧 Development

```bash
git clone https://github.com/Kaiyve/feishu-cc-agent.git
cd feishu-cc-agent
npm install
npm run dev -- start
```

## 📄 License

MIT

## 🙏 Acknowledgments

- [Claude Code](https://claude.ai/download) — Anthropic
- [@larksuiteoapi/node-sdk](https://github.com/larksuite/oapi-sdk-nodejs) — Feishu SDK
- [OpenClaw](https://github.com/openclaw/openclaw) — Memory architecture inspiration
