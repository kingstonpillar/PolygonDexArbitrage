import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
// ESM ONLY:
import {
  getReadProvider,
  rotateProvider,
  ensurePolygonNetwork,
} from './dataprovider.js';

/* =========================
   Paths & Config
========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEV_FILE = path.join(process.cwd(), 'mev_queue.json'); // shared with other modules

// Routers (targets) — optional file; reduces false positives when present
let routers = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, 'routers.json'), 'utf8');
  routers = JSON.parse(raw || '{}');
} catch {
  routers = {};
  console.warn('[scanner] routers.json missing/invalid; router-target checks will be reduced.');
}

const ROUTER_SET = new Set(
  Object.values(routers || {})
    .filter(v => typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v))
    .map(v => v.toLowerCase())
);

// Gas threshold (GWEI) for simple MEV signal (ethers v6 returns bigint)
const HIGH_GAS_LIMIT = (() => {
  try { return ethers.parseUnits(String(process.env.HIGH_GAS_GWEI || '300'), 'gwei'); }
  catch { return ethers.parseUnits('300', 'gwei'); }
})();

/* =========================
   Retention (keep last N hours)
========================= */
const SCANNER_MEV_MAX_AGE_HOURS = Number(process.env.SCANNER_MEV_MAX_AGE_HOURS || 24);
const MAX_AGE_MS = Math.max(1, SCANNER_MEV_MAX_AGE_HOURS) * 60 * 60 * 1000;

function safeReadQueue() {
  try {
    if (!fs.existsSync(MEV_FILE)) return [];
    const raw = fs.readFileSync(MEV_FILE, 'utf8');
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function pruneMevQueue(now = Date.now()) {
  try {
    const queue = safeReadQueue();
    if (!Array.isArray(queue) || queue.length === 0) return 0;
    const cutoff = now - MAX_AGE_MS;
    const fresh = queue.filter(e => {
      const ts = Number(e?.timestamp || 0);
      return Number.isFinite(ts) && ts >= cutoff;
    });
    if (fresh.length !== queue.length) {
      fs.writeFileSync(MEV_FILE, JSON.stringify(fresh, null, 2));
      console.log(`[scanner] Pruned MEV queue: kept ${fresh.length}, removed ${queue.length - fresh.length} (> ${SCANNER_MEV_MAX_AGE_HOURS}h old)`);
      return queue.length - fresh.length;
    }
    return 0;
  } catch (e) {
    console.warn('[scanner] pruneMevQueue failed:', e?.message || e);
    return 0;
  }
}

(function schedulePrune() {
  pruneMevQueue();                              // initial prune on boot
  setInterval(pruneMevQueue, 60 * 60 * 1000);  // hourly
})();

/* =========================
   ABIs & Interfaces (v6)
========================= */
const V2_IFACE = new ethers.Interface([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)'
]);

const V3_IFACE = new ethers.Interface([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)',
  'function exactInput(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)',
  'function multicall(bytes[] data) returns (bytes[] results)'
]);

/* =========================
   Utils
========================= */
function logToMevQueue(entry) {
  pruneMevQueue();
  const queue = safeReadQueue();
  if (!queue.some(q => q.hash === entry.hash)) {
    queue.push(entry);
    fs.writeFileSync(MEV_FILE, JSON.stringify(queue, null, 2));
    console.log(`[scanner] MEV risk logged: ${entry.hash}`);
  }
}

function isRouterTarget(to) {
  if (!to) return false;
  try { return ROUTER_SET.has(String(to).toLowerCase()); } catch { return false; }
}

// v6: bigint or null
function getEffectiveGasPrice(tx) {
  return (tx.maxFeePerGas ?? tx.gasPrice) ?? null;
}

function decodeV2Swap(data) {
  try {
    const parsed = V2_IFACE.parseTransaction({ data });
    const fn = parsed.name;

    if (fn === 'swapExactTokensForTokens') {
      const [amountIn, amountOutMin, path, to] = parsed.args;
      return {
        protocol: 'V2',
        method: fn,
        tokens: path.map(a => String(a)),
        amountIn: amountIn.toString(),
        minOut: amountOutMin.toString(),
        recipient: String(to)
      };
    }

    if (fn === 'swapExactETHForTokens') {
      const [amountOutMin, path, to] = parsed.args;
      return {
        protocol: 'V2',
        method: fn,
        tokens: path.map(a => String(a)),
        amountIn: 'NATIVE', // from tx.value
        minOut: amountOutMin.toString(),
        recipient: String(to)
      };
    }

    if (fn === 'swapExactTokensForETH') {
      const [amountIn, amountOutMin, path, to] = parsed.args;
      return {
        protocol: 'V2',
        method: fn,
        tokens: path.map(a => String(a)),
        amountIn: amountIn.toString(),
        minOut: amountOutMin.toString(),
        recipient: String(to)
      };
    }
  } catch (error) {
    console.error('[scanner] Error in decodeV2Swap:', error.message);
  }
  return null;
}

// V3 path = token(20) [fee(3) token(20)]*
function decodeV3Path(pathBytes) {
  const tokens = [];
  const hex = String(pathBytes).startsWith('0x') ? String(pathBytes).slice(2) : String(pathBytes);
  let i = 0;
  while (i + 40 <= hex.length) {
    const tokenHex = '0x' + hex.slice(i, i + 40);
    let addr = tokenHex;
    try { addr = ethers.getAddress(tokenHex); } catch { /* keep raw */ }
    tokens.push(addr);
    i += 40;
    if (i + 6 > hex.length) break;
    i += 6; // skip fee (3 bytes)
  }
  return tokens;
}

function decodeV3Swap(data) {
  try {
    const parsed = V3_IFACE.parseTransaction({ data });
    const fn = parsed.name;

    if (fn === 'exactInputSingle') {
      const p = parsed.args[0];
      return {
        protocol: 'V3',
        method: fn,
        tokens: [String(p.tokenIn), String(p.tokenOut)],
        amountIn: p.amountIn.toString(),
        minOut: p.amountOutMinimum.toString(),
        recipient: String(p.recipient),
        fee: Number(p.fee)
      };
    }

    if (fn === 'exactInput') {
      const [pathBytes, recipient, , amountIn, amountOutMinimum] = parsed.args;
      const tokens = decodeV3Path(pathBytes);
      return {
        protocol: 'V3',
        method: fn,
        tokens,
        amountIn: amountIn.toString(),
        minOut: amountOutMinimum.toString(),
        recipient: String(recipient)
      };
    }

    if (fn === 'multicall') {
      const calls = parsed.args[0] || [];
      const inner = calls.map(c => decodeV2Swap(c) || decodeV3Swap(c)).filter(Boolean);
      if (inner.length) {
        return { protocol: 'MULTICALL', method: 'multicall', inner };
      }
    }
  } catch (error) {
    console.error('[scanner] Error in decodeV3Swap:', error.message);
  }
  return null;
}

function decodeSwapCalldata(data) {
  return decodeV2Swap(data) || decodeV3Swap(data);
}

/* =========================
   Provider failover helper
========================= */
async function readFailover(reason = 'scanner_failover') {
  try { rotateProvider(reason); } catch {}
  await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 160)));
}

/* =========================
   Scanner (provider from dataprovider.js; HTTP-only polling)
========================= */

// 🔹 RPC Concurrency Limiter
const MAX_CONCURRENT_REQUESTS = 3;
const queue = [];

async function safeRpcCall(fn) {
  while (queue.length >= MAX_CONCURRENT_REQUESTS) {
    await new Promise(r => setTimeout(r, 50));
  }
  queue.push(1);
  try {
    return await fn();
  } finally {
    queue.pop();
  }
}

async function startScanner() {
  const label = '[READ]';

  // Ensure we’re on Polygon (137); helpful early guard
  try { await ensurePolygonNetwork(await getReadProvider()); }
  catch (e) {
    console.error(`${label} Wrong chain / RPC: ${e?.message || e}`);
    process.exit(2);
  }

  // Informational connect log
  try {
    const p0 = await getReadProvider();
    const n = await p0.getNetwork();
    console.log(`${label} Connected (chainId ${Number(n?.chainId)})`);
  } catch {
    console.log(`${label} Connected`);
  }

  // Track last processed block (use number for consistency)
  let lastProcessed = 0;
  const pollIntervalMs = 1500;

  async function scanLatestBlock() {
    try {
      const p = await getReadProvider();
      const bn = await safeRpcCall(() => p.getBlockNumber());
      if (lastProcessed && bn <= lastProcessed) return;

      const block = await safeRpcCall(() => p.getBlockWithTransactions(bn));
      if (!block || !Array.isArray(block.transactions)) {
        lastProcessed = bn;
        return;
      }

      for (const tx of block.transactions) {
        const effGas = getEffectiveGasPrice(tx); // bigint or null
        const gasIsHigh = effGas ? (effGas > HIGH_GAS_LIMIT) : false;
        const hitsRouter = isRouterTarget(tx.to);

        let decoded = null;
        if (hitsRouter || gasIsHigh) {
          if (tx.data && tx.data !== '0x') {
            decoded = decodeSwapCalldata(tx.data);
          }
        }

        if (gasIsHigh || hitsRouter || decoded) {
          const entry = {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            gasPrice: effGas ? effGas.toString() : null,
            timestamp: Date.now()
          };
          if (decoded) entry.decoded = decoded;
          if (tx.value) entry.txValue = tx.value.toString();
          logToMevQueue(entry);
        }
      }

      lastProcessed = bn;
    } catch (error) {
      console.warn(`${label} Error scanning block: ${error.message}`);
    }
  }

  const poller = setInterval(scanLatestBlock, pollIntervalMs);
  console.log(`${label} Polling latest blocks every ${pollIntervalMs}ms…`);

  // Heartbeat to detect silent drops (rotate via dataprovider on failure)
  const hbIntervalMs = 15000;
  setInterval(async () => {
    try {
      const p = await getReadProvider();
      await safeRpcCall(() => p.getBlockNumber());
    } catch {
      console.warn(`${label} Heartbeat failed. Rotating read RPC…`);
      await readFailover();
    }
  }, hbIntervalMs);
}

startScanner();
