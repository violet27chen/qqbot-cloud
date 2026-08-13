# QQBot Cloud

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/violet27chen/qqbot-cloud)

QQ 官方机器人接入大模型，在 **QQ 私聊** 中与大模型进行对话。

基于 **Cloudflare Workers + QQ 官方机器人 Webhook + OpenAI 兼容 API** 实现。

无需服务器，无需本地电脑长期运行。QQ 消息通过 Webhook 转发到 Cloudflare Worker，Worker 调用大模型 API，并将回复发送回 QQ。

---

## 架构

```text
用户 QQ 私聊
      │
      ▼
QQ 开放平台 Webhook
      │
      ▼
Cloudflare Worker
(src/index.ts)
      │
      ├── 验证 Ed25519 签名
      │
      ├── 读取 KV 对话上下文
      │
      ├── 调用 LLM API
      │
      ├── 保存聊天记录
      │
      ▼
QQ C2C API 回复消息
      │
      ▼
用户收到机器人回复
```

---

## 功能特性

* ✅ QQ C2C 私聊机器人
* ✅ 支持 OpenAI Compatible API
* ✅ Cloudflare Workers Serverless 部署
* ✅ Cloudflare KV 保存多轮对话
* ✅ Ed25519 Webhook 签名验证
* ✅ 支持自定义域名
* ✅ 无需服务器
* ✅ 支持 Cloudflare 免费套餐

---

## 前置条件

开始部署前，需要准备：

### 1. QQ 官方机器人

在 QQ 开放平台创建机器人：

https://q.qq.com

需要获取：

* `AppID`
* `AppSecret`

并开启：

* C2C 私聊能力
* Webhook 接入方式
* C2C 消息事件

---

### 2. 大模型 API

需要一个兼容 OpenAI API 格式的大模型服务。

准备：

```text
base_url
api_key
model
```

例如：

```text
https://api.example.com/v1
your-api-key
your-model
```

---

### 3. Cloudflare 账号

需要一个 Cloudflare 账号。

本项目使用：

* Cloudflare Workers
* Cloudflare KV

免费套餐即可运行。

---

# 🚀 部署

## 方式一：一键部署（推荐）

点击：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/violet27chen/qqbot-cloud)

Cloudflare 会自动 Fork 仓库并创建 Worker 项目。

部署完成后，需要手动完成：

1. 创建 KV Namespace
2. 绑定 KV
3. 设置 Secrets
4. 配置 QQ Webhook

> 注意：项目不会包含任何 API Key、QQ 密钥等敏感信息。

---

# 方式二：手动部署

## 1. 克隆项目

```bash
git clone https://github.com/violet27chen/qqbot-cloud.git

cd qqbot-cloud

npm install
```

---

## 2. 创建 KV Namespace

聊天上下文使用 Cloudflare KV 保存。

创建：

```bash
npx wrangler kv:namespace create "CHAT_HISTORY"
```

创建完成后：

进入：

```
Cloudflare Dashboard
 → Workers & Pages
 → qq-chat-worker
 → Settings
 → Bindings
```

添加：

```
Type:
KV Namespace

Variable name:
CHAT_HISTORY
```

选择刚刚创建的 KV。

保存。

---

## 3. 设置 Worker Secrets

不要将密钥写入 GitHub。

使用：

```bash
npx wrangler secret put LLM_BASE_URL

npx wrangler secret put LLM_API_KEY

npx wrangler secret put LLM_MODEL

npx wrangler secret put QQ_APP_ID

npx wrangler secret put QQ_CLIENT_SECRET
```

---

## 4. 部署 Worker

执行：

```bash
npm run deploy
```

或者：

```bash
npx wrangler deploy
```

成功后会得到：

```text
https://qqbot-cloud.xxx.workers.dev
```

Webhook 地址：

```text
https://qqbot-cloud.xxx.workers.dev/qq-webhook
```

---

# 环境变量

| 名称                 | 类型     | 说明               |
| ------------------ | ------ | ---------------- |
| `LLM_BASE_URL`     | Secret | OpenAI 兼容 API 地址 |
| `LLM_API_KEY`      | Secret | 大模型 API Key      |
| `LLM_MODEL`        | Secret | 模型名称             |
| `QQ_APP_ID`        | Secret | QQ Bot AppID     |
| `QQ_CLIENT_SECRET` | Secret | QQ Bot AppSecret |

---

# 配置 QQ Webhook

进入：

```
q.qq.com
 → 机器人
 → 开发设置
 → 接入方式
```

切换：

```
Webhook
```

填写：

```text
https://你的Worker域名/qq-webhook
```

例如：

```text
https://qqbot-cloud.xxx.workers.dev/qq-webhook
```

开启：

```
C2C消息事件
```

保存。

QQ 平台会发送验证请求。

Worker 会自动完成 Ed25519 签名验证。

---

# 本地开发

安装依赖：

```bash
npm install
```

复制：

```bash
cp .dev.vars.example .dev.vars
```

填写本地环境变量。

启动：

```bash
npm run dev
```

默认地址：

```text
http://localhost:8787
```

---

## 测试 Webhook

本地环境无法直接被 QQ 访问。

可以使用：

* Cloudflare Tunnel
* ngrok

例如：

```bash
cloudflared tunnel --url http://localhost:8787
```

然后将公网地址填写到 QQ Webhook。

---

# 技术实现

## Webhook 验证

项目使用：

```
@noble/curves
```

实现 Ed25519 签名验证。

流程：

```text
QQ 请求
   │
   ▼
读取签名 Header
   │
   ▼
Ed25519 验证
   │
   ├──失败 → 拒绝请求
   │
   └──成功 → 处理消息
```

---

## 对话上下文

聊天记录存储在 Cloudflare KV。

默认：

* 每个 QQ 用户独立上下文
* 保存最近 10 条消息
* 24 小时自动过期

---

## 异步处理

Worker 使用：

```javascript
ctx.waitUntil()
```

收到消息后：

1. 快速返回 QQ Webhook 请求
2. 后台调用大模型
3. 发送回复消息

避免大模型响应时间影响 QQ 5 秒限制。

---

# 自定义域名

支持绑定自己的 Worker 域名。

例如：

```text
https://bot.example.com
```

Webhook：

```text
https://bot.example.com/qq-webhook
```

---

# 项目结构

```text
qqbot-cloud
│
├── src
│   └── index.ts
│
├── wrangler.toml
├── package.json
├── .dev.vars.example
└── README.md
```

---

# License

MIT License

Copyright © 2026 陈海富
