# feishu-cc-agent

飞书 + AI Agent + Claude Code — 从手机操控你的编程 AI 🚀

> 在飞书上发消息，AI Agent 理解你的意图，简单问题直接回答，复杂任务自动交给本地 Mac 上的 Claude Code 执行。

## ✨ 特性

- **飞书原生** — WebSocket 长连接，支持群聊和私聊
- **智能 Agent** — 不是简单转发，能理解意图、智能路由
- **Claude Code 集成** — 复杂任务自动委派到本地 Mac 执行
- **任意 AI 提供商** — 支持智谱、DeepSeek、OpenRouter、LiteLLM 等
- **本地记忆** — SQLite 存储，零服务器、零配置
- **自动部署 Skills** — 安装时自动配置 Claude Code 技能
- **表情反馈** — 处理中显示随机表情，完成后消失
- **权限分级** — 管理员才能操作 Claude Code

## 🏗️ 架构

```
┌────────────────────────────────────────────────┐
│            feishu-cc-agent (本地 Mac)           │
│                                                │
│  📱 飞书 WebSocket ← @larksuiteoapi/node-sdk   │
│       ↓                                        │
│  🧠 Agent (任意 OpenAI 兼容 API)                │
│       ↓ 智能路由                                │
│  ┌─ 简单问题 → Agent 直接回答                   │
│  └─ 复杂任务 → Claude Code (本地执行)           │
│                                                │
│  💾 SQLite 记忆（本地文件，零配置）              │
│  📦 Auto-deployed Skills                       │
└────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 前提

- Node.js ≥ 20
- [Claude Code](https://code.claude.com) 已安装（如需本地执行功能）
- 飞书开放平台应用（[创建指南](#飞书应用配置)）
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
| "继续上次修改前端的任务" | Claude Code 搜索历史会话并继续 |
| "记住我喜欢用 TypeScript" | 保存到本地记忆 |

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
    "skipPermissions": true,
    "resumeSession": true
  }
}
```

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

## 🔒 权限模型

| 操作 | 谁能用 |
|------|--------|
| 普通对话 | 所有人 |
| Claude Code 任务 | 仅管理员 |
| 写全局记忆 | 仅管理员 |

管理员通过 `config.json` 的 `adminOpenIds` 配置。首次使用时从启动日志中获取你的 open_id。

## 📁 文件结构

```
~/.feishu-cc-agent/
  ├── config.json    # 配置文件
  └── memory.db      # SQLite 记忆数据库

~/.claude/skills/
  └── feishu-agent/  # 自动部署的 Claude Code Skill
      └── SKILL.md
```

## 🔧 开发

```bash
git clone https://github.com/xxx/feishu-cc-agent.git
cd feishu-cc-agent
npm install
npm run dev -- start
```

## 📄 License

MIT

## 🙏 致谢

- [Claude Code](https://code.claude.com) — Anthropic
- [@larksuiteoapi/node-sdk](https://github.com/larksuite/oapi-sdk-nodejs) — 飞书 SDK
- [cc-connect](https://github.com/chenhg5/cc-connect) — 灵感来源
