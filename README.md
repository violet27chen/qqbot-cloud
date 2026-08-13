# qqbot-cloud

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/violet27chen/qqbot-cloud)

QQ 官方机器人接入大模型，在 **QQ 私聊**里和大模型聊天。

完全无服务器：QQ 官方机器人通过 **Webhook** 把消息推送到 Cloudflare Worker，Worker 调大模型 API，再把回复发回 QQ 私聊。你**不需要本地开电脑**，也不需要买服务器。

```
你发 QQ 私聊
   ↓ 腾讯 Webhook POST
Cloudflare Worker (src/index.ts)
   ↓ 验证 Ed25519 签名
   ↓ 调 LLM API (OpenAI 兼容)
   ↓ 回复通过 QQ C2C 接口发回
你的 QQ 收到机器人回复
```

## 前置条件

1. QQ 开放平台创建了 C2C 单聊机器人（"仅供创建人使用"那种），拿到 `AppID` 和 `AppSecret`。
2. 一个 **OpenAI 兼容**的大模型 API：`base_url`、`api_key`、`model`。
3. 一个 Cloudflare 账号（免费即可）。

## 配置

```bash
cd qq-chat-worker
npm install
```

复制 `.dev.vars.example` → `.dev.vars` 并填好变量（生产用 `wrangler secret put` 设置）。

## 部署：Cloudflare Worker 版

### 0. 一键部署（推荐新手）

点上面的 **Deploy to Cloudflare Workers** 按钮：Cloudflare 会自动把仓库 fork 到你账号、自动创建 KV 命名空间并改写 `wrangler.toml` 里的 id、构建并部署。整个过程几分钟，无需本地装环境。

部署完成后仍需设置 5 个 secret（见第 3 步），按钮本身出于安全考虑不会预填密钥。

### 1. 先建 KV（保存对话上下文）

```bash
npx wrangler kv:namespace create "CHAT_HISTORY"
```

把返回的 id 填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "CHAT_HISTORY"
id = "你刚拿到的id"
```

### 2. 部署

```bash
npm run deploy   # 即 npx wrangler deploy
```

部署成功后会显示一个 `https://qq-chat-worker.xxx.workers.dev` 地址。

### 3. 设置环境变量（生产 secret）

```bash
npx wrangler secret put LLM_BASE_URL
npx wrangler secret put LLM_API_KEY
npx wrangler secret put LLM_MODEL
npx wrangler secret put QQ_APP_ID
npx wrangler secret put QQ_CLIENT_SECRET
```

### 4. QQ 后台配置 Webhook

1. 打开 q.qq.com → 你的机器人 → 开发设置 → 接入方式
2. 从 **WebSocket** 切换到 **Webhook**
3. 回调地址填：`https://qq-chat-worker.xxx.workers.dev/qq-webhook`
4. 监听事件至少勾 **C2C消息事件**
5. 保存。平台会立即发起验证请求，Worker 返回 Ed25519 签名通过验证

## 本地调试

```bash
npm run dev
# 用 cloudflare tunnel / ngrok 把本地 8787 暴露出去测试 webhook
```

## 说明

- 签名验证：使用 `@noble/curves` 的 Ed25519，与官方 Go `ed25519.GenerateKey` 一致（已交叉验证）。
- Ed25519 派生方式严格遵循 QQ 文档：`secret` 重复补足 32 字节作为 seed，seed 经 SHA-512 派生私钥。
- 多轮上下文用 KV 保存，保留最近 10 条对话，24 小时过期。
- Worker 用 `ctx.waitUntil()` 先回 200 再后台跑 LLM，不受 QQ 5 秒窗口限制，最稳。
- 自定义域名可绑到 Worker，再填进 QQ Webhook 回调地址。

## License

MIT — Copyright (c) 2026 陈海富
