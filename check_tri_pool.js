// check_tri_pool.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listenTelegramAlerts, sendTelegramAlert } from "./telegramalert.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRI_POOL_FILE = path.join(process.cwd(), "tri_pool.json"); // align with direct (cwd)

// -------- utils --------
function loadTriPool(retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      if (!fs.existsSync(TRI_POOL_FILE)) return [];
      const raw = fs.readFileSync(TRI_POOL_FILE, "utf8");
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.trades)) return parsed.trades;
      return [];
    } catch (err) {
      if (i === retries) {
        console.error("[TriPool] Failed to read JSON:", err.message);
        return [];
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return [];
}

function saveTriPool(pool) {
  try {
    const tmp = path.join(path.dirname(TRI_POOL_FILE), `.${path.basename(TRI_POOL_FILE)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(pool, null, 2));
    fs.renameSync(tmp, TRI_POOL_FILE);
  } catch (err) {
    console.error("[TriPool] Failed to save JSON:", err.message);
  }
}

function normalizeId(x) {
  if (x == null) return null;
  if (typeof x === "object") x = x.tradeId ?? x.id ?? null;
  if (x == null) return null;
  return String(x).trim();
}

function getEmoji(type) {
  const t = (type || "").toLowerCase();
  return t === "successful" ? "✅" : t === "skip" ? "⏭️" : t === "fail" ? "❌" : "ℹ️";
}
function cap(s) { return typeof s === "string" && s ? s[0].toUpperCase() + s.slice(1) : ""; }

// -------- core --------
function removeFromTriPool(typeRaw, tradeIdRaw) {
  try {
    const type = (typeRaw || "").toString().toLowerCase();
    const tradeId = normalizeId(tradeIdRaw);
    if (!tradeId) {
      console.warn("[TriPool] Missing tradeId in alert, ignoring.");
      return;
    }

    let pool = loadTriPool();
    const before = pool.length;

    pool = pool.filter(item => normalizeId(item) !== tradeId);

    if (pool.length !== before) {
      saveTriPool(pool);
      console.log(`[TriPool] Removed ${type || "info"} tradeId: ${tradeId}`);
      try { sendTelegramAlert(`${getEmoji(type)} ${cap(type) || "Info"} trade ${tradeId} removed from tri_pool.json`); } catch {}
    } else {
      console.log(`[TriPool] TradeId not found: ${tradeId}`);
      try { sendTelegramAlert(`⚠️ Trade ${tradeId} not found in tri_pool.json`); } catch {}
    }
  } catch (err) {
    console.error("[TriPool] Error processing trade:", err.message);
  }
}

// 🔥 Listen for alerts
listenTelegramAlerts?.((payload) => {
  try {
    let data = payload;
    if (typeof payload === "string") {
      try { data = JSON.parse(payload); } catch { data = { type: payload }; }
    }
    const type = (data?.type ?? data?.status ?? "").toString().toLowerCase();
    const tradeId = data?.tradeId ?? data?.id ?? null;

    if (["successful", "skip", "fail"].includes(type) && tradeId != null) {
      removeFromTriPool(type, tradeId);
    }
  } catch (e) {
    console.error("[TriPool] Listener error:", e.message);
  }
});
