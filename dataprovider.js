// dataprovider.js — robust, same logic preserved; fixes/guards for invalid chainId argument
// NOTE: Ethers v6 compatible

import { POLYGON_CHAIN_ID, POLYGON_RPCS, WRITE_RPC_URL } from "./rpcConfig.js";
import { ethers } from "ethers";
import { sendTelegramAlert } from "./telegramalert.js";

// ==================================================
// CONFIG: quota + threshold
// ==================================================
const QUOTAS = {
  alchemy: 100_000,
  infura: 3_000_000,
  getblock: 50_000,
  chainstack: 50_000,
  official: 100_000,
  default: 100_000,
};
const RPC_THRESHOLD = 0.8;

// ==================================================
// CHAIN ID NORMALIZATION (prevents "invalid chainId argument")
// ==================================================
function normalizeChainId(v) {
  // Accept bigint | number | string; coerce to safe integer number
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid POLYGON_CHAIN_ID: ${String(v)}`);
  }
  return n;
}
const CHAIN_ID = normalizeChainId(POLYGON_CHAIN_ID);

// Build a Networkish object; avoids ethers complaining about chainId type
const NETWORKISH = { name: "polygon", chainId: CHAIN_ID };

// ==================================================
// TRACKING STATE
// ==================================================
const rpcUsage = {};
[WRITE_RPC_URL, ...POLYGON_RPCS].filter(Boolean).forEach((url) => (rpcUsage[url] = 0));

function detectType(url) {
  if (!url) return "default";
  if (url.includes("alchemy")) return "alchemy";
  if (url.includes("infura")) return "infura";
  if (url.includes("getblock")) return "getblock";
  if (url.includes("chainstack")) return "chainstack";
  if (url.includes("polygon-rpc")) return "official";
  return "default";
}

// ==================================================
// TRACKING + ROTATION
// ==================================================
async function trackUsageAndRotate(url, type = "read") {
  const provType = detectType(url);
  const quota = QUOTAS[provType] ?? QUOTAS.default;

  rpcUsage[url] = (rpcUsage[url] || 0) + 1;
  const usagePercent = rpcUsage[url] / quota;

  if (usagePercent >= RPC_THRESHOLD) {
    const msg = `⚠️ ${type.toUpperCase()} RPC *${provType}* hit ${Math.floor(
      usagePercent * 100
    )}% quota\nRotating from:\n${url}`;
    try {
      await sendTelegramAlert(msg);
    } catch (_) {
      // non-fatal
    }

    if (type === "read") rotateProvider(`quota-${Math.floor(usagePercent * 100)}`);
    else _rotateWrite();
  }
}

// ==================================================
// CONCURRENT RPC LIMITER
// ==================================================
const MAX_CONCURRENT_REQUESTS = 3;
const __queue = [];
const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeRpcCall(fn) {
  while (__queue.length >= MAX_CONCURRENT_REQUESTS) {
    await __sleep(50);
  }
  __queue.push(1);
  try {
    return await fn();
  } finally {
    __queue.pop();
  }
}

// ==================================================
// WRAP provider.send to count requests + failover
// ==================================================
function wrapProvider(p, url, type = "read") {
  const origSend = p.send.bind(p);
  p.send = async (...args) => {
    try {
      await trackUsageAndRotate(url, type);
      return await origSend(...args);
    } catch (err) {
      const msg = `❌ ${type.toUpperCase()} RPC failed\n${url}\nError: ${err?.message || err}`;
      try {
        await sendTelegramAlert(msg);
      } catch (_) {}
      if (type === "read") return rotateProvider("dead-rpc").send(...args);
      return _rotateWrite().send(...args);
    }
  };
  return p;
}

// ==================================================
// WRITE PROVIDERS
// ==================================================
const WRITE_RPC_URLS = [WRITE_RPC_URL, ...POLYGON_RPCS].filter(Boolean);
let _wIdx = 0;
let _write = null;

function _buildWriteProvider(idx) {
  const url = WRITE_RPC_URLS[idx];
  // Use NETWORKISH to avoid "invalid chainId argument"
  const p = new ethers.JsonRpcProvider(url, NETWORKISH);
  return wrapProvider(p, url, "write");
}

function _ensureWrite() {
  if (!_write) _write = _buildWriteProvider(_wIdx);
  return _write;
}

function _rotateWrite() {
  if (WRITE_RPC_URLS.length < 2) return _ensureWrite();
  const prev = WRITE_RPC_URLS[_wIdx];
  _wIdx = (_wIdx + 1) % WRITE_RPC_URLS.length;
  _write = _buildWriteProvider(_wIdx);
  const next = WRITE_RPC_URLS[_wIdx];
  try {
    sendTelegramAlert(`♻️ WRITE RPC rotated\nFrom: ${prev}\nTo: ${next}`);
  } catch (_) {}
  return _write;
}

export function getWriteProvider() {
  return _ensureWrite();
}

// ==================================================
// READ PROVIDERS
// ==================================================
const READ_RPC_URLS = [...POLYGON_RPCS].filter(Boolean);
let _rIdx = 0;
let _read = null;

function _buildReadProvider(idx) {
  const url = READ_RPC_URLS[idx];
  // Use NETWORKISH to avoid "invalid chainId argument"
  const p = new ethers.JsonRpcProvider(url, NETWORKISH);
  return wrapProvider(p, url, "read");
}

function _ensureRead() {
  if (!_read) _read = _buildReadProvider(_rIdx);
  return _read;
}

export function rotateProvider(reason = "manual") {
  if (READ_RPC_URLS.length < 2) return _ensureRead();
  const prev = READ_RPC_URLS[_rIdx];
  _rIdx = (_rIdx + 1) % READ_RPC_URLS.length;
  _read = _buildReadProvider(_rIdx);
  const next = READ_RPC_URLS[_rIdx];
  try {
    sendTelegramAlert(`♻️ READ RPC rotated (${reason})\nFrom: ${prev}\nTo: ${next}`);
  } catch (_) {}
  return _read;
}

// quick health probe
async function _isHealthy(p, timeoutMs = 1500) {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs));
  try {
    await Promise.race([p.getBlockNumber(), timeout]);
    return true;
  } catch {
    return false;
  }
}

export async function getReadProvider() {
  if (READ_RPC_URLS.length <= 1) return _ensureRead();

  const c0 = _ensureRead();
  const c1 = _buildReadProvider((_rIdx + 1) % READ_RPC_URLS.length);
  const c2 = _buildReadProvider((_rIdx + 2) % READ_RPC_URLS.length);

  const checks = await Promise.all(
    [c0, c1, c2].map((p) =>
      _isHealthy(p)
        .then((ok) => ({ ok, p }))
        .catch(() => ({ ok: false, p }))
    )
  );

  const winner = checks.find((c) => c.ok)?.p;
  if (winner) return winner;

  return rotateProvider("dead-rpc");
}

export function getProvider() {
  return _ensureRead();
}

// ==================================================
// NETWORK SANITY
// ==================================================
export async function ensurePolygonNetwork(p = _ensureRead()) {
  const net = await p.getNetwork();
  // ethers v6 returns bigint for chainId; normalize to number for comparison
  const cid = normalizeChainId(net.chainId);
  if (cid !== CHAIN_ID) {
    throw new Error(`[dataprovider] Wrong chain: expected ${CHAIN_ID}, got ${cid}`);
  }
  return true;
}

export async function verifySameChain() {
  const readNet = await _ensureRead().getNetwork();
  const rId = normalizeChainId(readNet.chainId);
  if (rId !== CHAIN_ID) {
    throw new Error(`Read provider chainId ${rId} != ${CHAIN_ID}`);
  }
  const writeNet = await _ensureWrite().getNetwork();
  const wId = normalizeChainId(writeNet.chainId);
  if (wId !== CHAIN_ID) {
    throw new Error(`Write provider chainId ${wId} != ${CHAIN_ID}`);
  }
  return true;
}

export default {
  getProvider,
  getReadProvider,
  rotateProvider,
  ensurePolygonNetwork,
  getWriteProvider,
  verifySameChain,
};
