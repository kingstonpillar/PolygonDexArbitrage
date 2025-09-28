// assign_ids.js — watch direct_pool.json & tri_pool.json and add deterministic IDs instantly
// Drop-in: just `import './assign_ids.js'` at the top of index.js

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const DIRECT_FILE = path.join(ROOT, "direct_pool.json");
const TRI_FILE    = path.join(ROOT, "tri_pool.json");
const TARGET_FILES = new Set([DIRECT_FILE, TRI_FILE]);

// ------------- small utils -------------
const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const naddr  = (x) => (isAddr(x) ? x.toLowerCase() : String(x ?? "").toLowerCase());
const nstr   = (x) => String(x ?? "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ------------- fingerprints & ids (deterministic) -------------
function shortHash(payload) {
  const s = JSON.stringify(payload);
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}
function fpDirect(o = {}) {
  return {
    token0: naddr(o.token0),
    token1: naddr(o.token1),
    poolAddrA: naddr(o.poolAddrA),
    poolAddrB: naddr(o.poolAddrB),
    dexA: nstr(o.dexA),
    dexB: nstr(o.dexB),
    routerA: naddr(o.routerA),
    routerB: naddr(o.routerB),
    styleA: nstr(o.styleA),
    styleB: nstr(o.styleB),
    feeA: o.feeA ?? null,
    feeB: o.feeB ?? null,
  };
}
function fpTri(o = {}) {
  const route = Array.isArray(o.route) ? o.route.map(naddr) : [];
  const pools = Array.isArray(o.pools) ? o.pools.map(naddr) : [];
  const dexs  = Array.isArray(o.dexs)  ? o.dexs.map(nstr)   : [];
  const fees  = Array.isArray(o.fees)  ? o.fees.map((x) => x ?? null) : [];
  return { route, pools, dexs, fees };
}
function directId(o) { return `direct-${shortHash(fpDirect(o))}`; }
function triId(o)    { return `tri-${shortHash(fpTri(o))}`; }

// ------------- IO helpers -------------
function ensureFile(file) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
  } catch {}
}
function writeAtomic(file, arr) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, file);
}
function parseJsonSafe(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

// robust loader that retries briefly if writer is in the middle of an atomic rename
async function loadArrayRobust(file, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, "utf8");
      if (!raw.trim()) return [];
      const parsed = parseJsonSafe(raw);
      if (!parsed) throw new Error("parse error");
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.trades)) return parsed.trades; // tolerate { trades: [...] }
      return [];
    } catch {
      if (i === retries) return [];
      await sleep(60); // tiny backoff for atomic writer
    }
  }
  return [];
}

function addIdsAndDedupe(items, computeId) {
  const map = new Map();
  for (const it of items) {
    const copy = { ...it };
    copy.id ||= computeId(copy);
    const key = copy.id;

    const prev = map.get(key);
    if (!prev) {
      map.set(key, copy);
    } else {
      // prefer higher estProfitUSD; tie-break by newer timestamp
      const aP = Number(prev.estProfitUSD || 0);
      const bP = Number(copy.estProfitUSD || 0);
      if (bP > aP) map.set(key, copy);
      else if (bP === aP) {
        const aT = Number(prev.timestamp || 0);
        const bT = Number(copy.timestamp || 0);
        if (bT > aT) map.set(key, copy);
      }
    }
  }
  return [...map.values()];
}

// ------------- core pass -------------
async function processFile(file) {
  try {
    ensureFile(file);
    const items = await loadArrayRobust(file);
    if (!Array.isArray(items)) return;

    const isDirect = file === DIRECT_FILE;
    const next = isDirect
      ? addIdsAndDedupe(items, directId)
      : addIdsAndDedupe(items, triId);

    // Only write if there is at least one missing id or a dedupe change
    const changed = next.length !== items.length || next.some((x, i) => (items[i]?.id !== x.id));
    if (changed) writeAtomic(file, next);

    console.log(`[assign_ids] ${path.basename(file)} -> ${next.length} entries`);
  } catch (e) {
    console.warn(`[assign_ids] error on ${path.basename(file)}: ${e.message}`);
  }
}

// ------------- bootstrap + watchers -------------
// Run once at startup to normalize current contents
await Promise.all([processFile(DIRECT_FILE), processFile(TRI_FILE)]);

// Watch the directory so we catch atomic renames (the writer uses a temp file then renames)
const DIR = ROOT;
const onFsEvent = debounce(async () => {
  // Only touch known targets; ignore other file churn
  await Promise.all([processFile(DIRECT_FILE), processFile(TRI_FILE)]);
}, 100);

// fs.watch can coalesce events; debounce keeps us efficient but near-instant
try {
  fs.watch(DIR, { persistent: true }, (eventType, filename) => {
    if (!filename) return;
    const full = path.join(DIR, filename);
    if (TARGET_FILES.has(full)) onFsEvent();
    // also handle writers that create a tmp then rename: trigger on any change to dir
    if (filename.endsWith(".tmp")) onFsEvent();
    if (filename === path.basename(DIRECT_FILE) || filename === path.basename(TRI_FILE)) onFsEvent();
  });
  console.log("[assign_ids] watcher armed (instant ID assignment on new opportunities)");
} catch (e) {
  console.warn("[assign_ids] watcher failed, falling back to light polling.");
  // ultra-light safety net (every 2s) in case fs.watch is not reliable in the environment
  setInterval(() => onFsEvent(), 2000);
}
