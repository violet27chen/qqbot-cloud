// qq-chat-worker/src/index.ts
// Cloudflare Worker: 接收 QQ 官方机器人 Webhook，调大模型，把回复发回 QQ 私聊。
// 完全无服务器，7×24 运行，不需要用户本地开电脑。
//
// 链路：
//   用户 QQ 私聊 → 腾讯 Webhook POST → 本 Worker
//   → 验证 Ed25519 签名 → 调 LLM API → 调用 QQ C2C 发消息接口 → 用户收到回复

import { ed25519 } from '@noble/curves/ed25519';

export interface Env {
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;
  QQ_APP_ID: string;
  QQ_CLIENT_SECRET: string;
  CHAT_HISTORY: KVNamespace;
}

const SYSTEM_PROMPT =
  '你是一个 helpful 的 AI 助手，通过 QQ 私聊回复用户。回复简洁、口语化。';
const MAX_HISTORY = 10;

// ======== Ed25519 签名工具 ========

function textEncoder(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function deriveEd25519Seed(secret: string): Uint8Array {
  // QQ 规则：secret 重复直到 >=32 字节，取前 32 字节作为 Ed25519 seed
  // 与 Go ed25519.GenerateKey(reader) 语义一致：seed 经 SHA-512 派生私钥
  let s = secret;
  while (s.length < 32) s += s;
  return textEncoder(s.slice(0, 32));
}

function signQQWebhook(plainToken: string, eventTs: string, secret: string): string {
  const seed = deriveEd25519Seed(secret);
  const { secretKey: privateKey } = ed25519.keygen(seed);
  const msg = textEncoder(eventTs + plainToken);
  const sig = ed25519.sign(msg, privateKey);
  return bytesToHex(sig);
}

function verifyQQWebhook(
  bodyText: string,
  timestamp: string,
  signatureHex: string,
  secret: string
): boolean {
  try {
    const seed = deriveEd25519Seed(secret);
    const { secretKey: privateKey } = ed25519.keygen(seed);
    const publicKey = ed25519.getPublicKey(privateKey);
    const msg = textEncoder(timestamp + bodyText);
    const sig = new Uint8Array(signatureHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    return ed25519.verify(sig, msg, publicKey);
  } catch {
    return false;
  }
}

// ======== QQ Token / 发消息 ========

async function getQQAccessToken(appId: string, secret: string): Promise<string> {
  const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
  });
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error('QQ access_token 获取失败: ' + JSON.stringify(data));
  }
  return data.access_token;
}

async function sendC2CMessage(
  userOpenid: string,
  content: string,
  env: Env
): Promise<void> {
  const token = await getQQAccessToken(env.QQ_APP_ID, env.QQ_CLIENT_SECRET);
  const resp = await fetch(`https://api.sgroup.qq.com/v2/users/${userOpenid}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `QQBot ${token}`,
      'X-Union-Appid': env.QQ_APP_ID,
    },
    body: JSON.stringify({ msg_type: 0, content }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`发送 QQ 消息失败 [${resp.status}]: ${err}`);
  }
}

// ======== LLM 调用 ========

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

async function callLLM(messages: ChatMessage[], env: Env): Promise<string> {
  const resp = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`LLM 请求失败 [${resp.status}]: ${err}`);
  }
  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() || '(AI 没有返回内容)';
}

async function getHistory(kv: KVNamespace, userOpenid: string): Promise<ChatMessage[]> {
  try {
    const raw = await kv.get(`chat:${userOpenid}`);
    if (!raw) return [{ role: 'system', content: SYSTEM_PROMPT }];
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return [{ role: 'system', content: SYSTEM_PROMPT }];
  }
}

async function saveHistory(
  kv: KVNamespace,
  userOpenid: string,
  messages: ChatMessage[]
): Promise<void> {
  // 只保留系统提示 + 最近 MAX_HISTORY 条对话
  const trimmed = [messages[0], ...messages.slice(-MAX_HISTORY)];
  await kv.put(`chat:${userOpenid}`, JSON.stringify(trimmed), { expirationTtl: 86400 });
}

// ======== Worker 入口 ========

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 只允许 POST
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    // 可以配 /qq-webhook 路径，也兼容根路径
    if (url.pathname !== '/' && url.pathname !== '/qq-webhook') {
      return new Response('Not Found', { status: 404 });
    }

    const bodyText = await request.text();

    // 验证签名（QQ 事件推送都带 X-Signature-Ed25519 + X-Signature-Timestamp）
    const signature = request.headers.get('X-Signature-Ed25519') || '';
    const timestamp = request.headers.get('X-Signature-Timestamp') || '';
    if (signature && timestamp) {
      const ok = verifyQQWebhook(bodyText, timestamp, signature, env.QQ_CLIENT_SECRET);
      if (!ok) {
        console.warn('[QQ Webhook] 签名验证失败');
        return new Response('invalid signature', { status: 401 });
      }
    }

    let payload: any;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return new Response('bad json', { status: 400 });
    }

    // QQ 配置回调地址时的验证请求：op=13，payload.d 含 plain_token + event_ts
    const plainToken = payload.d?.plain_token || payload.plain_token || '';
    const eventTs = payload.d?.event_ts || payload.event_ts || '';

    if (plainToken && eventTs) {
      const sig = signQQWebhook(plainToken, eventTs, env.QQ_CLIENT_SECRET);
      return new Response(JSON.stringify({ plain_token: plainToken, signature: sig }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 普通事件推送：C2C 私聊消息
    if (payload.op === 0 && payload.t === 'C2C_MESSAGE_CREATE') {
      const d = payload.d || {};
      const userOpenid = d.author?.user_openid as string;
      const userContent = (d.content || '') as string;

      if (!userOpenid || !userContent) {
        return new Response('ok', { status: 200 });
      }

      // 关键：QQ 要求 5 秒内返回 200，否则取消请求。
      // 所以先用 ctx.waitUntil 把耗时的 LLM 调用+回复放到后台，立即返回 200。
      ctx.waitUntil(
        (async () => {
          try {
            const messages = await getHistory(env.CHAT_HISTORY, userOpenid);
            messages.push({ role: 'user', content: userContent });

            const reply = await callLLM(messages, env);

            messages.push({ role: 'assistant', content: reply });
            await saveHistory(env.CHAT_HISTORY, userOpenid, messages);

            await sendC2CMessage(userOpenid, reply, env);
          } catch (e: any) {
            console.error('[处理失败]', e);
            try {
              await sendC2CMessage(userOpenid, `处理出错：${e.message}`, env);
            } catch {}
          }
        })()
      );

      // 立即返回，让 QQ 满意
      return new Response('ok', { status: 200 });
    }

    return new Response('ok', { status: 200 });
  },
};
