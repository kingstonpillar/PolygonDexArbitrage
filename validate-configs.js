// validate-configs.js — Routers-only with auto-correct (ethers v6, provider-rotation safe)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers, Contract } from "ethers";
import { sendTelegramAlert } from "./telegramalert.js";
import { getProvider, rotateProvider } from "./dataprovider.js";

let provider = getProvider();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- util: JSON ---
function readJson(rel) {
  const p = path.join(__dirname, rel);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`[JSON READ ERROR] ${rel}:`, err);
    return {};
  }
}

function writeJson(rel, data) {
  const p = path.join(__dirname, rel);
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[JSON WRITE ERROR] ${rel}:`, err);
  }
}

function isAddr(a) {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

// --- retry wrapper (with provider rotation) ---
async function safeCall(fn, retries = 3, delayMs = 1000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`[RPC ERROR] attempt ${i + 1}: ${err?.message || err}`);
      try { provider = rotateProvider(`validate-configs attempt ${i + 1}`); } catch {}
      if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return null;
}

// --- alert throttle ---
const alertedKeys = new Set();
async function alertOnce(key, msg) {
  if (alertedKeys.has(key)) return;
  alertedKeys.add(key);
  try {
    await sendTelegramAlert(msg);
  } catch (e) {
    console.warn(`[ALERT ERROR] ${e?.message || e}`);
  }
}

// --- router validator (contract bound per-attempt via safeCall) ---
async function validateRouter(addr) {
  if (!isAddr(addr)) return { ok: false, reason: "bad_address" };

  const abiV2 = ["function factory() view returns (address)"];

  // Build the Contract inside safeCall so it rebinds to the rotated provider on retries
  const factory = await safeCall(async () => {
    const c = new (Contract ?? ethers.Contract)(addr, abiV2, provider);
    return c.factory();
  });

  if (factory && isAddr(factory)) return { ok: true, reason: "v2" };

  const code = await safeCall(async () => provider.getCode(addr));
  if (code && code !== "0x") return { ok: true, reason: "no_factory_method" };

  return { ok: false, reason: "no_code_or_call_failed" };
}

// --- auto-correct using factory() (contract bound per-attempt via safeCall) ---
async function autoCorrectRouter(addr) {
  if (!isAddr(addr)) return null;
  const abi = ["function factory() view returns (address)"];

  const factory = await safeCall(async () => {
    const c = new (Contract ?? ethers.Contract)(addr, abi, provider);
    return c.factory();
  });

  if (factory && isAddr(factory)) {
    const check = await validateRouter(addr);
    if (check.ok) return addr;
  }
  return null;
}

// --- main loop ---
async function runOnce() {
  let routers = readJson("./routers.json");
  let changed = false;

  for (const [name, addr] of Object.entries(routers)) {

    // ✅ Convert to proper checksum right away
    let checksummedAddr;
    try {
      checksummedAddr = ethers.getAddress(addr);
    } catch (err) {
      console.warn(`⚠️ Invalid address for ${name}: ${addr}, setting to 0x0`);
      routers[name] = "0x0000000000000000000000000000000000000000";
      await alertOnce(`router-invalid:${name}`, `⚠️ Invalid address for ${name}: ${addr}`);
      changed = true;
      continue; // skip this router
    }

    // Use the checksummed address from now on
    const { ok, reason } = await validateRouter(checksummedAddr);

    if (!ok) {
      console.warn(`⚠️ Router flagged for ${name}: ${checksummedAddr} (${reason})`);

      const corrected = await autoCorrectRouter(checksummedAddr);
      if (corrected) {
        routers[name] = corrected; // store corrected checksum
        console.log(`🔧 Auto-corrected router for ${name}: ${corrected}`);
        await alertOnce(`router-corrected:${name}`, `🔧 Auto-corrected router for ${name}: ${corrected}`);
      } else {
        routers[name] = "0x0000000000000000000000000000000000000000";
        await alertOnce(`router:${name}`, `⚠️ Router for ${name} quarantined: ${checksummedAddr} (${reason})`);
      }

      changed = true;
    } else {
      routers[name] = checksummedAddr; // store checksum even if valid
    }
  }

  if (changed) {
    writeJson("./routers.json", routers);
    console.log("✅ Routers validated & corrected/quarantined where needed.");
  } else {
    console.log("✅ All routers valid, no changes.");
  }
}

// ✅ mainLoop function
async function mainLoop(intervalMs = 30000) {
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      console.error("[VALIDATOR CRASH DURING ITERATION]", err);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

mainLoop().catch(err => {
  console.error("[VALIDATOR CRASH AT STARTUP]", err);
});