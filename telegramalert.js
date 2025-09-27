// telegram.js — ESM version (compatible with ethers v6 project)
// package.json: { "type": "module" }

import dotenv from "dotenv";
import axios from "axios";
import { EventEmitter } from "events";

dotenv.config();

// ----- helpers -----
function pickEnvByChain(baseKey, chainId) {
  const cid = String(chainId ?? "");
  const perChain = process.env[`${baseKey}__${cid}`];
  return perChain || process.env[baseKey];
}

function getCfg(chainId) {
  const token = pickEnvByChain("TELEGRAM_BOT_TOKEN", chainId);
  const chatIdsRaw = pickEnvByChain("TELEGRAM_CHAT_ID", chainId);
  const threadIdRaw = pickEnvByChain("TELEGRAM_THREAD_ID", chainId);

  const chatIds = (chatIdsRaw || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    // normalize to numbers when possible, else string
    .map(v => {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    });

  const threadIdNum = Number(threadIdRaw);
  const threadId = Number.isFinite(threadIdNum) ? threadIdNum : undefined;

  return { token, chatIds, threadId };
}

// Telegram MarkdownV2 requires escaping these characters:
// _ * [ ] ( ) ~ ` > # + - = | { } . !
function escapeMarkdownV2(text) {
  let safe = String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  return safe;
}

// Split into chunks, ensuring (for MarkdownV2) that no chunk ends with
// an odd number of trailing backslashes (which would escape EOF).
function chunkMessage(text, { maxLen = 4000, markdownV2 = true } = {}) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    let part = text.slice(i, end);

    if (markdownV2) {
      // If the chunk ends with an odd run of backslashes, pull one char back
      let backslashes = 0;
      for (let k = part.length - 1; k >= 0 && part[k] === "\\"; k--) backslashes++;
      if (backslashes % 2 === 1 && end < text.length) {
        end -= 1;
        part = text.slice(i, end);
      }
      // Also avoid splitting inside a code fence or inline code – minimal heuristic:
      // if chunk ends with an unmatched single backtick, pull back until it’s matched.
      const tickCount = (part.match(/`/g) || []).length;
      if (tickCount % 2 === 1 && end < text.length) {
        // pull back to last non-backtick if possible
        const lastNonTick = part.lastIndexOf("`") - 1;
        if (lastNonTick > 0) {
          end = i + lastNonTick;
          part = text.slice(i, end);
        }
      }
    }

    // Telegram still dislikes a final lone backslash; pad with space
    if (markdownV2 && part.endsWith("\\")) part += " ";
    chunks.push(part);
    i = end;
  }
  return chunks;
}

function isFiniteInt(n) {
  return Number.isInteger(n) && Number.isFinite(n);
}

// Minimal retry for 429/5xx
async function postWithRetry(url, payload, { retries = 2, timeout = 15000 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await axios.post(url, payload, { timeout });
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      // backoff only on rate/5xx
      if (status === 429 || (status >= 500 && status < 600) || err.code === "ETIMEDOUT") {
        const retryAfterMs = Number(err?.response?.headers?.["retry-after"]) * 1000 || (500 * (attempt + 1));
        await new Promise(r => setTimeout(r, retryAfterMs));
        attempt++;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ----- main sender -----
async function sendTelegramAlert(message, opts = {}) {
  const chainId = opts.chainId ?? process.env.CHAIN_ID;
  const { token, chatIds: envChatIds, threadId: envThreadId } = getCfg(chainId);

  const chatIds = Array.isArray(opts.chatIds) && opts.chatIds.length
    ? opts.chatIds
    : envChatIds;

  const tId = typeof opts.threadId === "number" ? opts.threadId : envThreadId;
  const threadId = isFiniteInt(tId) ? tId : undefined;

  if (!token || !chatIds.length) {
    console.error("[TELEGRAM] Missing token or chat id(s). Set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID.");
    return;
  }

  const parseMode = opts.parseMode || "MarkdownV2"; // default to V2
  const disableWebPagePreview = !!opts.disablePreview;
  const disableNotification = !!opts.disableNotification;

  const finalText = parseMode === "MarkdownV2"
    ? escapeMarkdownV2(message)
    : String(message);

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const chunks = chunkMessage(finalText, { maxLen: 4000, markdownV2: parseMode === "MarkdownV2" });

  for (const chat_id of chatIds) {
    for (const part of chunks) {
      const payload = {
        chat_id,
        text: part,
        parse_mode: parseMode,
        disable_web_page_preview: disableWebPagePreview,
        disable_notification: disableNotification,
      };
      if (isFiniteInt(threadId)) payload.message_thread_id = threadId;

      try {
        await postWithRetry(url, payload, { retries: 2, timeout: 15000 });
        console.log(`[TELEGRAM] Sent to ${chat_id}${threadId ? `#${threadId}` : ""}: ${part.slice(0, 80)}${part.length > 80 ? "…" : ""}`);
      } catch (err) {
        const msg = err?.response?.data?.description || err.message;
        console.error(`[TELEGRAM] Failed for ${chat_id}: ${msg}`);
      }
    }
  }
}

// ----- shared event emitter -----
const alertEmitter = new EventEmitter();

async function sendAndEmit(message, opts = {}) {
  await sendTelegramAlert(message, opts);

  const text = String(message).toLowerCase();
  let type = null;
  if (text.includes("successful trade")) type = "successful";
  else if (text.includes("skip trade")) type = "skip";
  else if (text.includes("fail trade")) type = "fail";

  if (type) {
    const match = String(message).match(/id[:\s]*([^\s]+)/i);
    const tradeId = match ? match[1] : null;

    if (tradeId) {
      alertEmitter.emit("alert", { type, tradeId });
      console.log(`📨 Local Alert -> type: ${type}, tradeId: ${tradeId}`);
    }
  }
}

// ----- subscription API -----
function listenTelegramAlerts(callback) {
  alertEmitter.on("alert", callback);
}

// ----- exports -----
export {
  sendAndEmit as sendTelegramAlert,
  sendAndEmit as send,
  listenTelegramAlerts
};
export default sendAndEmit;
