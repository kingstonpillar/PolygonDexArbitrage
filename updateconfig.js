// updateconfig.js — refreshes tokenlist & Chainlink feeds, then merges any extras (ESM)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// Rebuild __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Files
const TOKENLIST_FILE = path.join(__dirname, 'tokenlist.json');
const PRICEFEED_FILE = path.join(__dirname, 'chainlinkpricefeed.json');
const ROUTERS_FILE   = path.join(__dirname, 'routers.json');

// Helpers
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    }
    return parsed ?? fallback;
  } catch (err) {
    console.error(`⚠️ Failed to read/parse ${path.basename(file)}: ${err.message}. Using fallback.`);
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const size = Array.isArray(data) ? data.length : Object.keys(data || {}).length;
  console.log(`✅ Updated ${path.basename(file)} with ${size} entr${size === 1 ? 'y' : 'ies'}`);
}

// Merge helpers
function mergeTokenlist(existing = [], additions = []) {
  const byAddr = new Map();
  for (const t of existing) {
    if (t && isAddr(t.address)) byAddr.set(t.address.toLowerCase(), t);
  }
  for (const t of additions) {
    if (!t || !isAddr(t.address)) continue;
    const key = t.address.toLowerCase();
    // prefer new decimals if present and valid
    const prev = byAddr.get(key) || {};
    const decimals = Number.isFinite(Number(t.decimals)) ? Number(t.decimals) : prev.decimals ?? 18;
    byAddr.set(key, { ...prev, ...t, decimals });
  }
  // Cap at 220 (FIFO: keep most recent preference at the end)
  const arr = Array.from(byAddr.values());
  return arr.length > 220 ? arr.slice(arr.length - 220) : arr;
}

function mergeFeeds(existing = {}, additions = {}) {
  return { ...existing, ...additions };
}

function mergeRouters(existing = {}, additions = {}) {
  return { ...existing, ...additions };
}

// Run a local script with inherited stdio (visible logs)
function runNode(scriptRelPath, env = {}) {
  const scriptAbs = path.join(__dirname, scriptRelPath);
  if (!fs.existsSync(scriptAbs)) {
    console.warn(`⚠️ Skipping ${scriptRelPath} (not found).`);
    return;
  }
  console.log(`▶️ Running ${scriptRelPath}...`);
  execSync(`node ${JSON.stringify(scriptAbs)}`, {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  console.log(`✅ Finished ${scriptRelPath}`);
}

// Main exported function
export default async function updateConfig(newTokens = [], newPriceFeeds = {}, newRouters = {}) {
  try {
    console.log('⚙️ updateconfig.js starting…');

    // 1) Refresh tokenlist.json via your updatetokenlist.js (uses dataprovider.js inside)
    try {
      runNode('./updatetokenlist.js', {
        TARGET_COUNT: process.env.TARGET_COUNT || '220',
      });
    } catch (e) {
      console.warn('⚠️ updatetokenlist.js failed (continuing with existing tokenlist):', e?.message || e);
    }

    // 2) Refresh chainlinkpricefeed.json via your getchainlinkpricefeed.js
    try {
      runNode('./getchainlinkpricefeed.js');
    } catch (e) {
      console.warn('⚠️ getchainlinkpricefeed.js failed (continuing with existing price feeds):', e?.message || e);
    }

    // 3) Load refreshed files
    let tokenlist = loadJSON(TOKENLIST_FILE, []);
    let feeds     = loadJSON(PRICEFEED_FILE, {});
    let routers   = loadJSON(ROUTERS_FILE, {});

    // 4) Merge any provided in-memory updates (optional)
    if (Array.isArray(newTokens) && newTokens.length) {
      tokenlist = mergeTokenlist(tokenlist, newTokens);
    }
    if (newPriceFeeds && typeof newPriceFeeds === 'object') {
      feeds = mergeFeeds(feeds, newPriceFeeds);
    }
    if (newRouters && typeof newRouters === 'object') {
      routers = mergeRouters(routers, newRouters);
    }

    // 5) Save back
    saveJSON(TOKENLIST_FILE, tokenlist);
    saveJSON(PRICEFEED_FILE, feeds);
    saveJSON(ROUTERS_FILE, routers);

    console.log('🎯 Config update complete.');
  } catch (e) {
    console.error('❌ updateconfig error:', e?.message || e);
  }
}

// If run directly: do a no-arg refresh (pure external-scripts update)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    await updateConfig();
  })();
}
