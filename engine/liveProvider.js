// engine/liveProvider.js
// LIVE MODE integration point. If ENERGY_API_URL is set (see .env.example),
// EcoSync polls it in the background and feeds real readings into the
// engine. If it isn't set, or the endpoint is unreachable/invalid, EcoSync
// automatically falls back to SIMULATION MODE and says so honestly through
// /api/health and the dashboard's DATA SOURCE indicator — it never silently
// relabels simulated numbers as live.
//
// Expected external API response shape (adapt the parsing below to match
// your real meter/provider's actual JSON):
//   { "solarKw": 3.2, "demandKw": 2.1, "batterySoc": 61 }

const ENERGY_API_URL = process.env.ENERGY_API_URL || '';
const ENERGY_API_KEY = process.env.ENERGY_API_KEY || '';
const POLL_MS = 8000;
const STALE_MS = 30000;
const TIMEOUT_MS = 5000;

let latest = null; // { solar, demand, batterySoC, fetchedAt }
let lastError = null;
let lastAttemptAt = null;

function isConfigured() {
  return !!ENERGY_API_URL;
}

async function pollOnce() {
  if (!ENERGY_API_URL) return;
  lastAttemptAt = Date.now();
  try {
    if (typeof fetch !== 'function') {
      throw new Error('This Node.js runtime has no global fetch (need Node 18+) — cannot reach a live API.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(ENERGY_API_URL, {
        headers: ENERGY_API_KEY ? { Authorization: `Bearer ${ENERGY_API_KEY}` } : {},
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`Live energy API responded with HTTP ${res.status}`);
    const data = await res.json();
    if (typeof data.solarKw !== 'number' || typeof data.demandKw !== 'number') {
      throw new Error('Live energy API response is missing numeric solarKw/demandKw fields');
    }
    latest = {
      solar: data.solarKw,
      demand: data.demandKw,
      batterySoC: typeof data.batterySoc === 'number' ? data.batterySoc : null,
      fetchedAt: Date.now(),
    };
    lastError = null;
  } catch (err) {
    lastError = String((err && err.message) || err);
  }
}

if (isConfigured()) {
  pollOnce();
  setInterval(pollOnce, POLL_MS);
}

// Returns null if live data isn't currently usable (not configured, never
// fetched successfully, or the last good reading is stale) — the caller
// should fall back to simulation in that case.
function getLiveReading() {
  if (!isConfigured()) return null;
  if (!latest) return null;
  if (Date.now() - latest.fetchedAt > STALE_MS) return null;
  return latest;
}

function status() {
  return {
    configured: isConfigured(),
    connected: !!getLiveReading(),
    lastError,
    lastAttemptAt: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : null,
    lastSuccessAt: latest ? new Date(latest.fetchedAt).toISOString() : null,
    pollIntervalMs: POLL_MS,
  };
}

module.exports = { isConfigured, getLiveReading, status };
