// 旗標訂餐系統 — 後端伺服器
// 1. 提供前端頁面 index.html
// 2. POST /api/analyze-menu：抓取菜單網址內容，交給 Claude 分析出品項清單

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = 'claude-opus-5-5';
const MAX_PAGE_CHARS = 150_000; // 網頁文字上限，避免送出過大的內容

// 從環境變數 ANTHROPIC_API_KEY（可寫在 .env）讀取金鑰
const client = new Anthropic();

// Claude 回傳的 JSON 格式（Structured Outputs 會保證符合這個 schema）
const MENU_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '品名' },
          price: { type: 'number', description: '價格（數字，不含貨幣符號）；若有多種尺寸取最低價' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '客製化選項，例如甜度、冰塊、辣度、尺寸、加料；沒有則為空陣列',
          },
        },
        required: ['name', 'price', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `你是菜單分析助手。使用者會提供一份餐廳菜單（網頁文字或圖片），請找出所有可點的品項。
- name：品名，保留菜單上的原文。
- price：數字價格；同一品項有多種尺寸或價格時，取最低價，並把尺寸放進 options（例如「中杯」「大杯 +10」）。
- options：該品項可選的客製化選項（甜度、冰塊、辣度、尺寸、加料等）。若菜單寫的是全店通用選項（例如所有飲料都可調甜度冰塊），請套用到相關品項。沒有就給空陣列。
- 忽略導覽列、頁尾、營業時間、地址等非品項內容。
- 如果內容裡找不到任何菜單品項，回傳空的 items 陣列。`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 把 HTML 轉成純文字
function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// 抓取菜單網址，回傳要送給 Claude 的內容區塊
async function fetchMenuContent(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FlagOrderBot/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(502, `無法開啟菜單網址：${err.message}`);
  }
  if (!res.ok) {
    throw new HttpError(502, `菜單網址回應錯誤（HTTP ${res.status}）`);
  }

  const contentType = res.headers.get('content-type') || '';

  // 菜單是圖片：直接讓 Claude 看圖
  if (contentType.startsWith('image/')) {
    return [{ type: 'image', source: { type: 'url', url } }];
  }

  const text = htmlToText(await res.text());
  if (!text) {
    throw new HttpError(422, '這個網址沒有可讀的文字內容（可能需要 JavaScript 才能顯示）');
  }
  if (text.length > MAX_PAGE_CHARS) {
    throw new HttpError(413, `網頁內容過長（${text.length} 字），請改貼只有菜單的網址`);
  }
  return [{ type: 'text', text: `菜單網址：${url}\n\n網頁內容：\n${text}` }];
}

// 呼叫 Claude 分析菜單
async function analyzeMenu(url) {
  const content = await fetchMenuContent(url);

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // 若被安全機制拒絕，由伺服器自動改用備援模型重試
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: MENU_SCHEMA },
    },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') {
    throw new HttpError(422, '無法分析這份內容');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new HttpError(422, '菜單品項太多，分析結果被截斷');
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new HttpError(500, 'Claude 沒有回傳分析結果');
  }
  return JSON.parse(textBlock.text);
}

// 讀取 request body（JSON）
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, '請求格式錯誤，必須是 JSON');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// 把各種錯誤轉成給前端看的訊息
function toHttpError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new HttpError(500, 'Claude API 金鑰無效或未設定，請檢查 .env 的 ANTHROPIC_API_KEY');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(429, 'Claude API 請求太頻繁，請稍後再試');
  }
  if (err instanceof Anthropic.APIError) {
    return new HttpError(502, `Claude API 錯誤（${err.status ?? '連線失敗'}）：${err.message}`);
  }
  if (err?.message?.includes('Could not resolve authentication method')) {
    return new HttpError(500, '尚未設定 Claude API 金鑰，請在 .env 填入 ANTHROPIC_API_KEY');
  }
  return new HttpError(500, `伺服器錯誤：${err.message}`);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  try {
    // 前端頁面
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = await fs.readFile(path.join(here, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // 分析菜單
    if (req.method === 'POST' && pathname === '/api/analyze-menu') {
      const { url } = await readJson(req);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new HttpError(400, '請提供有效的菜單網址');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new HttpError(400, '網址必須以 http:// 或 https:// 開頭');
      }

      console.log(`[analyze] ${parsed.href}`);
      const result = await analyzeMenu(parsed.href);
      console.log(`[analyze] 找到 ${result.items.length} 個品項`);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: '找不到這個路徑' });
  } catch (err) {
    const httpErr = toHttpError(err);
    console.error(`[error] ${httpErr.status} ${httpErr.message}`);
    sendJson(res, httpErr.status, { error: httpErr.message });
  }
});

server.listen(PORT, () => {
  console.log(`旗標訂餐系統已啟動：http://localhost:${PORT}`);
});
