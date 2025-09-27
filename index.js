// index.js — ESM + ethers v6, Polygon RPC-only (no .env)
// Ensure package.json has: { "type": "module" }

import { JsonRpcProvider } from 'ethers';
import { POLYGON_RPCS } from './rpcConfig.js';

// ⬇️ NEW — Assign IDs to all opportunities before anything starts
import './assign_ids.js';

// Import crash protection module
import { protect } from './crash-protection.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function probeRpc(url, attempts = 3) {
  const p = new JsonRpcProvider(url);
  for (let i = 1; i <= attempts; i++) {
    try {
      const bn = await p.getBlockNumber();
      console.log(`🟢 RPC ok @ ${url} (block ${bn})`);
      return true;
    } catch (e) {
      console.log(`🟠 RPC probe ${i}/${attempts} failed @ ${url}: ${e?.message || e}`);
      if (i < attempts) await sleep(400 * i);
    }
  }
  return false;
}

async function pickWorkingRpc() {
  for (const url of POLYGON_RPCS) {
    if (await probeRpc(url)) return url;
  }
  throw new Error('No Polygon RPC endpoint reachable from fallback list.');
}

function startModule(name, modulePath) {
  const start = async () => {
    console.log(`🚀 Starting ${name}...`);
    try {
      await import(modulePath);
      console.log(`✅ ${name} loaded successfully.`);
    } catch (err) {
      console.error(`❌ ${name} crashed:`, err?.message || err);
      console.log(`⏳ Restarting ${name} in 5 seconds...`);
      setTimeout(start, 5000);
    }
  };
  start();
}

// 1) Probe one working RPC; expose it globally for consumers
const ACTIVE_RPC = await pickWorkingRpc();
globalThis.__ACTIVE_POLYGON_RPC__ = ACTIVE_RPC;
console.log(`🔗 Using ACTIVE Polygon RPC: ${ACTIVE_RPC}`);

// 2) Start crash protection (This will monitor and restart the bot if necessary)
protect();

// 3a) Run validate-configs.js first to ensure configs are validated and fixed
await import('./validate-configs.js'); // Validate configs before starting the rest of the modules

// 3b) Start remaining modules after validation
const modules = [
  { name: 'Data Provider (RPC)',        path: './dataprovider.js' },
  { name: 'Pool Fetcher',               path: './poolfetcher.js' },
  { name: 'Scanner',                    path: './scanner.js' },
  { name: 'Protection Utilities',       path: './protectionutilities.js' },
  { name: 'Hybrid Simulation Bot',      path: './hybridsimulationbot.js' },
  { name: 'Chainlink Price Feed',       path: './getchainlinkpricefeed.js' },
  { name: 'Token List Updater',         path: './updatetokenlist.js' },
  { name: 'Direct Pool Listener',       path: './checkdirectpool.js' },
  { name: 'Tri Pool Listener',          path: './check_tri_pool.js' },
];

// Start all remaining modules
modules.forEach(m => startModule(m.name, m.path));

console.log('🎯 Polygon RPC confirmed. Services are starting…');

// graceful shutdown
function shutdown(sig) {
  console.log(`\n${sig} received. Attempting graceful shutdown…`);
  setTimeout(() => process.exit(0), 500);
}
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => shutdown(s)));
