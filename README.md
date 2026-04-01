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
| 本地执行 | 飞书发消息 → Mac 上的 Claude Code 干活 → 结果私发管理员 |
| 跨会话记忆 | FTS5 全文搜索 + 自动提取事实 + 历史对话压缩，不是一次性聊天 |
| 任意 AI 提供商 | 智谱 / DeepSeek / OpenRouter / Ollama / OpenAI，自动适配 tool calling 差异 |
| 任务持久化 | Claude Code 任务队列存 SQLite，进程重启自动恢复 |
| 自动环境检测 | 启动时检测 Claude Code，未安装则自动 `npm install -g`，未认证则提示登录 |
| 权限 + 隔离 | 管理员才能触发 Claude Code；执行结果默认私发，不在群里广播 |

## 安装

**前提**：Node.js ≥ 20，飞书开放平台应用（[配置指南](#飞书应用配置)）

Claude Code 不需要提前装——`init` 向导会自动检测并安装。

```bash
npm install -g feishu-cc-agent
```

## 配置 → 启动

```bash
feishu-cc-agent init    # 交互式向导：飞书 App → AI API → Claude Code（自动安装） → 管理员
feishu-cc-agent start   # 启动前自动检测环境，未就绪则降级为 Agent-only 模式
```

## 使用

安装后直接在飞书给机器人发消息，Agent 自动判断怎么处理：

- "帮我解释一下 React hooks" → Agent 直接回答
- "帮我改一下登录页的样式" → 委派给 Claude Code
- "记住我喜欢用 TypeScript" → 保存到本地记忆
- "帮我跑一下测试" → Claude Code 执行，结果私发给你

## AI 提供商

| 提供商 | Base URL | 推荐模型 |
|-------|----------|---------|
| LiteLLM (自托管代理) | `https://your-litellm.example.com` | `anthropic.claude-sonnet-4` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |

任何 OpenAI 兼容端点都支持。不支持 tool calling 的模型会自动降级为文本模式。

<details>
<summary>💡 推荐：用 LiteLLM 做 Agent 的 AI 后端</summary>

**为什么用 LiteLLM？**

LiteLLM 是一个 OpenAI 兼容的 API 代理，一个端点统一调用 100+ 模型（Claude、GPT、Gemini、DeepSeek 等）。好处：
- **中国用户**：部署在海外服务器，绕过 Anthropic API 的中国 IP 封禁
- **统一 Key 管理**：一个 API Key 访问所有模型，不用每个提供商单独管理
- **负载均衡 + 降级**：主模型挂了自动切到备用模型
- **用量追踪**：按 Key、模型、用户统计 token 消耗

**快速部署 LiteLLM**

```bash
# 1. 在海外服务器（AWS/GCP/阿里云海外区）
pip install litellm[proxy]

# 2. 创建配置 config.yaml
cat > config.yaml << 'EOF'
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      api_key: sk-ant-xxx  # 你的 Anthropic API Key

  - model_name: deepseek
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: sk-xxx

general_settings:
  master_key: sk-your-litellm-master-key  # 自定义 master key
EOF

# 3. 启动
litellm --config config.yaml --port 4000

# 4. 生产环境用 Docker
docker run -d --name litellm \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -p 4000:4000 \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml
```

**在 feishu-cc-agent 中配置**

```bash
feishu-cc-agent init
# AI Provider → 选 Custom
# Base URL:  https://your-server:4000    （你的 LiteLLM 地址）
# API Key:   sk-your-litellm-master-key  （config.yaml 中的 master_key）
# Model:     claude-sonnet               （config.yaml 中的 model_name）
```

或直接编辑 `~/.feishu-cc-agent/config.json`：

```json
{
  "agent": {
    "baseUrl": "https://your-server:4000",
    "apiKey": "sk-your-litellm-master-key",
    "model": "claude-sonnet"
  }
}
```

**模型命名**

LiteLLM 的模型名取决于你在 `config.yaml` 中的 `model_name`。常见格式：
- 自定义别名：`claude-sonnet`（推荐，简洁）
- LiteLLM 原生格式：`anthropic/claude-sonnet-4-20250514`
- 第三方转发：`anthropic.novita.claude-sonnet-4`（通过 Novita AI 转发）

</details>

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
  "claudeCode": {
    "enabled": true,
    "skipPermissions": true,
    "resultDelivery": "private"
  }
}
```

`resultDelivery`：`"private"` 私发管理员（默认），`"source"` 发到触发的聊天

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
> 用户生成的记忆内容在 system prompt 中标记为不可信数据，防止 prompt injection。

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
| Local Execution | Send message on Feishu → Claude Code works on your Mac → result DM'd to admin |
| Cross-session Memory | FTS5 full-text search + auto fact extraction + conversation compression |
| Any AI Provider | ZhiPu / DeepSeek / OpenRouter / Ollama / OpenAI, auto-adapts tool calling differences |
| Task Persistence | Claude Code task queue in SQLite, auto-recovers on restart |
| Auto Environment Setup | Detects Claude Code on startup, auto-installs if missing, prompts login if needed |
| Permission + Isolation | Only admins can trigger Claude Code; results DM'd privately by default |

## Install

**Prerequisites**: Node.js ≥ 20, Feishu app ([Setup Guide](#feishu-app-setup))

Claude Code doesn't need to be pre-installed — the `init` wizard auto-detects and installs it.

```bash
npm install -g feishu-cc-agent
```

## Configure → Start

```bash
feishu-cc-agent init    # Interactive wizard: Feishu App → AI API → Claude Code (auto-install) → Admin
feishu-cc-agent start   # Auto-checks environment before launch, degrades to Agent-only if CC not ready
```

## Usage

Just message your bot on Feishu. The Agent decides how to handle it:

- "Explain React hooks" → Agent answers directly
- "Fix the login page styles" → Delegates to Claude Code
- "Remember I prefer TypeScript" → Saves to local memory
- "Run the tests" → Claude Code executes, result DM'd to you

## AI Providers

| Provider | Base URL | Recommended Model |
|----------|----------|-------------------|
| LiteLLM (self-hosted proxy) | `https://your-litellm.example.com` | `anthropic.claude-sonnet-4` |
| ZhiPu | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |

Any OpenAI-compatible endpoint works. Models without tool calling auto-fallback to text mode.

<details>
<summary>💡 Recommended: LiteLLM as Agent AI backend</summary>

[LiteLLM](https://github.com/BerriAI/litellm) is an OpenAI-compatible proxy — one endpoint to call 100+ models (Claude, GPT, Gemini, DeepSeek, etc.).

**Why LiteLLM?**
- **China users**: Deploy on overseas server to bypass Anthropic's China IP block
- **Unified keys**: One API key for all providers
- **Load balancing + fallback**: Auto-switch to backup model if primary is down
- **Usage tracking**: Per-key, per-model token usage stats

**Quick deploy:**

```bash
pip install litellm[proxy]

# config.yaml
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      api_key: sk-ant-xxx

general_settings:
  master_key: sk-your-master-key

# Start
litellm --config config.yaml --port 4000
```

**Configure in feishu-cc-agent:**

```json
{
  "agent": {
    "baseUrl": "https://your-server:4000",
    "apiKey": "sk-your-master-key",
    "model": "claude-sonnet"
  }
}
```

</details>

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
  "claudeCode": {
    "enabled": true,
    "skipPermissions": true,
    "resultDelivery": "private"
  }
}
```

`resultDelivery`: `"private"` DM to admin (default), `"source"` reply to trigger chat

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
> User-generated memory content is marked as untrusted data in the system prompt to prevent prompt injection.

## License

MIT

## Acknowledgments

- [Claude Code](https://claude.ai/download) — Anthropic
- [@larksuiteoapi/node-sdk](https://github.com/larksuite/oapi-sdk-nodejs) — Feishu SDK
- [OpenClaw](https://github.com/openclaw/openclaw) — Memory architecture & API compat reference
