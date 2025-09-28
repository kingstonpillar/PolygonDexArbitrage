// checkdirectpool.js
import fs from "fs";
import path from "path";
import { listenTelegramAlerts, sendTelegramAlert } from "./telegramalert.js";

const DIRECT_POOL_FILE = path.join(process.cwd(), "direct_pool.json");

// -------- utils --------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadDirectPool(retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      if (!fs.existsSync(DIRECT_POOL_FILE)) return [];
      const raw = fs.readFileSync(DIRECT_POOL_FILE, "utf8");
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (i === retries) {
        console.error("[DirectPool] Failed to read JSON:", err.message);
        return [];
      }
      // brief backoff in case file is mid-write/rename
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return [];
}

function saveDirectPool(pool) {
  try {
    const tmp = path.join(path.dirname(DIRECT_POOL_FILE), `.${path.basename(DIRECT_POOL_FILE)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(pool, null, 2));
    fs.renameSync(tmp, DIRECT_POOL_FILE);
  } catch (err) {
    console.error("[DirectPool] Failed to save JSON:", err.message);
  }
}

function normalizeId(x) {
  if (x == null) return null;
  if (typeof x === "object") x = x.id ?? x.tradeId ?? null;
  if (x == null) return null;
  return String(x).trim();
}

function getEmoji(type) {
  const t = (type || "").toLowerCase();
  return t === "successful" ? "✅" : t === "skip" ? "⏭️" : t === "fail" ? "❌" : "ℹ️";
}

function cap(s) { return typeof s === "string" && s ? s[0].toUpperCase() + s.slice(1) : ""; }

// -------- core --------
export function removeFromDirectPool(typeRaw, tradeIdRaw) {
  try {
    const type = String(typeRaw || "").toLowerCase();
    const tradeId = normalizeId(tradeIdRaw);
    if (!tradeId) {
      console.warn("[DirectPool] Missing tradeId in alert; ignoring.");
      return;
    }

    let pool = loadDirectPool();
    const before = pool.length;

    pool = pool.filter(item => normalizeId(item) !== tradeId);

    if (pool.length !== before) {
      saveDirectPool(pool);
      console.log(`[DirectPool] Removed ${type || "info"} tradeId: ${tradeId}`);
      try { sendTelegramAlert(`${getEmoji(type)} ${cap(type) || "Info"} trade ${tradeId} removed from direct_pool.json`); } catch {}
    } else {
      console.log(`[DirectPool] TradeId not found: ${tradeId}`);
      try { sendTelegramAlert(`⚠️ Trade ${tradeId} not found in direct_pool.json`); } catch {}
    }
  } catch (err) {
    console.error("[DirectPool] Error processing trade:", err.message);
  }
}

// 🔥 Listen for Telegram alerts and remove trades from pool
listenTelegramAlerts?.((payload) => {
  try {
    // Accept: { type, tradeId } or { status, id } or raw string JSON
    let data = payload;
    if (typeof payload === "string") {
      try { data = JSON.parse(payload); } catch { data = { type: payload }; }
    }
    const type = (data?.type ?? data?.status ?? "").toString().toLowerCase();
    const tradeId = data?.tradeId ?? data?.id ?? null;

    if (["successful", "skip", "fail"].includes(type) && tradeId != null) {
      removeFromDirectPool(type, tradeId);
    }
  } catch (e) {
    console.error("[DirectPool] Listener error:", e.message);
  }
});
