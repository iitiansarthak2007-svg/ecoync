// server.js
// EcoSync backend. Deliberately zero external dependencies (no Express,
// no npm install required) so it runs anywhere Node.js runs, offline —
// important for a hackathon demo room with no reliable Wi-Fi.
//
// NOTE ON SCOPE: this uses Node's built-in http module as a lightweight
// router, and a JSON file (data/state.json) as a stand-in for a real
// database. If you have npm access before the demo, this is a natural
// place to swap in Express + SQLite (better-sqlite3) without changing
// the engine/ logic at all — see README.md.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ---------- tiny built-in .env loader (no npm install required) ----------
// Only sets a variable if it isn't already set (so real host env vars, e.g.
// on Render/Railway, always win over a committed-by-mistake .env).
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
})();

const { state, DEVICES, hourFloat, tick, currentSnapshot, clockLabel,
        getBatteryCapacityKwh, getBatteryMinReservePct, getBatteryMaxRateKw,
        getCO2FactorKgPerKwh } = require('./engine/state');
const optimization = require('./engine/optimization');
const forecastEngine = require('./engine/forecast');
const scheduler = require('./engine/scheduler');
const settingsModule = require('./engine/settings');
const liveProvider = require('./engine/liveProvider');
const aiContext = require('./engine/aiContext');
const insightEngine = require('./engine/insightEngine');
const aiService = require('./engine/aiService');
// --- AI Copilot layer -------------------------------------------------------
// These modules are additive: every existing route below still works exactly
// as before if they are removed. analytics/anomaly/whatif/report are purely
// deterministic; aiAgent orchestrates them and only then involves a model.
const analytics = require('./engine/analytics');
const anomalyEngine = require('./engine/anomaly');
const whatif = require('./engine/whatif');
const reportEngine = require('./engine/report');
const memory = require('./engine/memory');
const aiTools = require('./engine/aiTools');
const aiAgent = require('./engine/aiAgent');

const PORT = process.env.PORT || 4600;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const START_TIME = Date.now();

// ---------- persistence (JSON-file "database") ----------
// Deliberately a JSON file, not an in-memory-only object: the point is that
// history/cumulative totals/device state survive a browser refresh AND a
// server restart. See README.md for swapping in SQLite/Postgres later
// without changing the engine/ or routes layer.
function persistSnapshot() {
  const snapshot = {
    savedAt: new Date().toISOString(),
    simSeconds: state.simSeconds,
    batterySoC: state.batterySoC,
    gridPrice: state.gridPrice,
    mode: state.mode,
    dataSource: state.dataSource,
    cumulative: state.cumulative,
    history: state.history,
    loads: state.loads.map((l) => ({ id: l.id, scheduledStart: l.scheduledStart, forcedStatus: l.forcedStatus })),
    alerts: state.alerts.slice(0, 30),
  };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFile(DATA_FILE, JSON.stringify(snapshot, null, 2), () => {});
}

function restoreSnapshot() {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (typeof saved.simSeconds === 'number') state.simSeconds = saved.simSeconds;
    if (typeof saved.batterySoC === 'number') state.batterySoC = saved.batterySoC;
    if (typeof saved.gridPrice === 'number') state.gridPrice = saved.gridPrice;
    if (Array.isArray(saved.history)) state.history = saved.history;
    if (Array.isArray(saved.alerts)) state.alerts = saved.alerts;
    if (saved.cumulative) state.cumulative = { ...state.cumulative, ...saved.cumulative };
    if (Array.isArray(saved.loads)) {
      saved.loads.forEach((sl) => {
        const load = state.loads.find((l) => l.id === sl.id);
        if (load) {
          load.scheduledStart = sl.scheduledStart;
          load.forcedStatus = sl.forcedStatus;
        }
      });
    }
    console.log(`Restored persisted state from ${DATA_FILE} (saved ${saved.savedAt || 'unknown time'}).`);
    return true;
  } catch (err) {
    console.warn('Could not restore persisted state, starting fresh:', err.message);
    return false;
  }
}

restoreSnapshot();

let tickCount = 0;
setInterval(() => {
  tick(1); // 1 real second per tick
  tickCount += 1;
  if (tickCount % 10 === 0) persistSnapshot();
}, 1000);

// ---------- helpers ----------
function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    // Safe to allow from anywhere: this API only ever returns simulated /
    // aggregate energy data, never secrets, so a separately-hosted frontend
    // (e.g. static hosting + API on another host) can call it directly.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ---------- EcoSync AI: basic per-IP rate limit ----------
// A simple in-memory token bucket, reset every minute. Good enough to stop
// one runaway client from burning through the Groq quota during a demo —
// not a substitute for a real gateway in production.
const AI_RATE_LIMIT = Number(process.env.AI_RATE_LIMIT || 120); // requests per window
const AI_RATE_WINDOW_MS = 60000;
const aiRateBuckets = new Map(); // ip -> { count, resetAt }
function checkAiRateLimit(req) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const entry = aiRateBuckets.get(ip);
  if (!entry || now > entry.resetAt) {
    aiRateBuckets.set(ip, { count: 1, resetAt: now + AI_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= AI_RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

// Maps an AIError's `code` to an appropriate HTTP status, and always sends a
// clean, human-readable message — never a raw stack trace or secret.
function sendAIError(res, err) {
  const code = err && err.code;
  const status = code === 'not_configured' ? 503
    : code === 'auth' ? 502
    : code === 'rate_limit' ? 429
    : code === 'timeout' ? 504
    : 500;
  sendJSON(res, status, { error: (err && err.message) || 'AI request failed.', code: code || 'unknown' });
}

function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .filter((h) => h && typeof h.content === 'string' && h.content.trim())
    .slice(-8)
    .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 2000) }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(full);
    // The frontend assets are edited in place during development and demos.
    // Without an explicit Cache-Control header browsers fall back to heuristic
    // caching and will happily keep serving an old styles.css/app.js after the
    // file on disk has changed — which looks exactly like "my changes did
    // nothing". These files are small and local, so revalidating every time
    // costs nothing and removes that whole class of confusion.
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, must-revalidate',
    });
    res.end(data);
  });
}

// ---------- API handlers ----------
const api = {};

api['GET /api/dashboard'] = (req, res) => {
  sendJSON(res, 200, {
    ...currentSnapshot(),
    loadsActive: state.loads.filter((l) => l.forcedStatus !== 'off').length,
    alertCount: state.alerts.length,
    battery: {
      capacityKwh: getBatteryCapacityKwh(),
      soc: state.batterySoC,
      minReservePct: getBatteryMinReservePct(),
      maxRateKw: getBatteryMaxRateKw(),
    },
  });
};

api['GET /api/energy'] = (req, res) => {
  sendJSON(res, 200, {
    current: state.history[state.history.length - 1] || null,
    history: state.history,
  });
};

// ---- Spec-named REST aliases (GET /api/energy/current etc.) ----
// Kept as thin aliases over the same state so there is exactly one source
// of truth; the dashboard above uses the richer /api/dashboard + /api/energy.
api['GET /api/energy/current'] = (req, res) => {
  sendJSON(res, 200, state.history[state.history.length - 1] || currentSnapshot());
};
api['GET /api/energy/history'] = (req, res) => {
  sendJSON(res, 200, { history: state.history });
};
api['GET /api/energy/generation'] = (req, res) => {
  sendJSON(res, 200, {
    history: state.history.map((h) => ({ t: h.t, hourLabel: h.hourLabel, solar: h.solar })),
  });
};
api['GET /api/energy/consumption'] = (req, res) => {
  sendJSON(res, 200, {
    history: state.history.map((h) => ({ t: h.t, hourLabel: h.hourLabel, demand: h.demand })),
  });
};
api['GET /api/energy/battery'] = (req, res) => api['GET /api/battery'](req, res);

api['GET /api/health'] = (req, res) => {
  sendJSON(res, 200, {
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
    dataSourceMode: state.dataSource,
    liveApi: liveProvider.status(),
    simRunning: true,
    historyPoints: state.history.length,
    timestamp: new Date().toISOString(),
  });
};

api['GET /api/ai/status'] = (req, res) => {
  sendJSON(res, 200, aiService.providerStatus());
};

api['GET /api/settings'] = (req, res) => {
  sendJSON(res, 200, settingsModule.getSettings());
};
api['POST /api/settings'] = async (req, res) => {
  const body = await readJSONBody(req).catch(() => null);
  if (!body || typeof body !== 'object') {
    return sendJSON(res, 400, { error: 'Invalid settings payload — expected a JSON object.' });
  }
  const updated = settingsModule.saveSettings(body);
  sendJSON(res, 200, updated);
};

api['GET /api/forecast'] = (req, res) => {
  sendJSON(res, 200, forecastEngine.forecastNext24(hourFloat(), state.history));
};

api['GET /api/battery'] = (req, res) => {
  const last = state.history[state.history.length - 1];
  const BATTERY_MIN_RESERVE_PCT = getBatteryMinReservePct();
  sendJSON(res, 200, {
    capacityKwh: getBatteryCapacityKwh(),
    soc: state.batterySoC,
    minReservePct: BATTERY_MIN_RESERVE_PCT,
    maxChargeRateKw: getBatteryMaxRateKw(),
    maxDischargeRateKw: getBatteryMaxRateKw(),
    mode: state.overrideMode,
    status: state.batterySoC <= BATTERY_MIN_RESERVE_PCT
      ? 'AT MINIMUM RESERVE'
      : state.batterySoC >= 98
      ? 'FULL'
      : last && last.decision === 'CHARGE BATTERY'
      ? 'CHARGING'
      : last && last.decision === 'DISCHARGE BATTERY'
      ? 'DISCHARGING'
      : 'IDLE',
  });
};

api['GET /api/loads'] = (req, res) => {
  sendJSON(res, 200, {
    loads: state.loads.map((l) => ({
      ...l,
      status: l.forcedStatus === 'off' ? 'MANUALLY OFF' : l.forcedStatus === 'on' ? 'MANUALLY ON' : l.scheduledStart != null ? 'SCHEDULED' : 'PENDING',
    })),
  });
};

api['GET /api/alerts'] = (req, res) => {
  sendJSON(res, 200, { alerts: state.alerts });
};

api['GET /api/devices'] = (req, res) => {
  sendJSON(res, 200, {
    devices: DEVICES.map((d) => ({
      ...d,
      dataSource: 'SIMULATION',
      status: 'SIMULATION MODE — no physical device connected',
      lastSeen: clockLabel(),
    })),
    architecture: 'Energy Meter -> RS485/Modbus -> ESP32 -> WiFi -> MQTT -> EcoSync Backend',
    note: 'No hardware is connected in this build. Readings are produced by the SimulationDataProvider. Swap in an MQTTDataProvider against the same API surface once meters are on site.',
  });
};

api['GET /api/impact'] = (req, res) => {
  const c = state.cumulative;
  const co2Factor = getCO2FactorKgPerKwh();
  const renewBefore = c.demandTotal > 0 ? Math.round((c.renewableServedBaseline / c.demandTotal) * 100) : 0;
  const renewAfter = c.demandTotal > 0 ? Math.round((c.renewableServed / c.demandTotal) * 100) : 0;
  const cfg = settingsModule.getSettings();
  sendJSON(res, 200, {
    windowNote: 'Accumulated since the current simulation clock last reset.',
    gridImport: { before: round2(c.gridImportBaseline), after: round2(c.gridImport) },
    renewableUtilizationPct: { before: renewBefore, after: renewAfter },
    peakDemandKw: { before: round2(c.peakDemandBaseline), after: round2(c.peakDemandActual) },
    costRupees: { before: round2(c.costBaseline), after: round2(c.costActual) },
    co2ReductionKg: round2((c.gridImportBaseline - c.gridImport) * co2Factor),
    exportRevenueRupees: round2(c.exportRevenue || 0),
    solarSavingsRupees: round2(c.solarSavings || 0),
    assumptions: {
      tariff: cfg.tariff,
      gridPricePerKwhNow: state.gridPrice,
      co2FactorKgPerKwh: co2Factor,
      baselineDefinition: 'Without EcoSync: direct solar-to-load only, no battery mediation, flexible loads run at their original/unoptimized times.',
    },
  });
};

api['POST /api/optimize'] = async (req, res) => {
  const body = await readJSONBody(req).catch(() => ({}));
  if (body && (body.solar != null || body.demand != null)) {
    const preview = optimization.decide({
      solar: body.solar ?? currentSnapshot().solar,
      demand: body.demand ?? currentSnapshot().demand,
      batterySoC: body.batterySoC ?? state.batterySoC,
      minReserve: getBatteryMinReservePct(),
      batteryAvailable: body.batteryAvailable !== false,
      gridAvailable: body.gridAvailable !== false,
    });
    return sendJSON(res, 200, { preview: true, ...preview });
  }
  sendJSON(res, 200, { preview: false, ...(state.lastDecision || {}) });
};

api['POST /api/schedule'] = async (req, res) => {
  const body = await readJSONBody(req).catch(() => ({}));
  const gridPrice = body.gridPrice ?? state.gridPrice;
  const forecast = forecastEngine.forecastNext24(hourFloat(), state.history);
  const result = scheduler.optimizeSchedule(state.loads, forecast.points, gridPrice);
  result.results.forEach((r) => {
    const load = state.loads.find((l) => l.id === r.id);
    if (load) load.scheduledStart = r.after.start;
  });
  sendJSON(res, 200, result);
};

api['POST /api/simulation'] = async (req, res) => {
  const body = await readJSONBody(req).catch(() => ({}));

  if (body.demoAction) {
    if (body.demoAction === 'start') {
      state.mode = 'DEMO';
      if (state.demoStatus === 'idle') resetDemo();
      state.demoStatus = 'running';
    } else if (body.demoAction === 'pause') {
      state.demoStatus = 'paused';
    } else if (body.demoAction === 'reset') {
      resetDemo();
      state.demoStatus = 'idle'; // back to 06:00 and waiting, not still "paused"
    } else if (body.demoAction === 'exit') {
      state.mode = 'AMBIENT';
      state.demoStatus = 'idle';
    }
  }

  // NOTE: dataSource is no longer settable directly here — it is derived
  // automatically every tick from whether ENERGY_API_URL is configured and
  // reachable (see engine/liveProvider.js). This prevents the UI from ever
  // claiming "Live API" when nothing real is actually connected.

  if (Object.prototype.hasOwnProperty.call(body, 'manualScenario')) {
    state.manualScenario = body.manualScenario; // null clears it
  }

  if (body.overrideMode) {
    state.overrideMode = body.overrideMode === 'MANUAL' ? 'MANUAL' : 'AUTO';
  }

  if (body.loadId && body.forcedStatus !== undefined) {
    const load = state.loads.find((l) => l.id === body.loadId);
    if (!load) {
      return sendJSON(res, 400, { ok: false, error: 'Unknown load id.' });
    }
    if (load.critical && body.forcedStatus === 'off') {
      return sendJSON(res, 200, {
        ok: false,
        error: `${load.name} is a critical load and cannot be switched off automatically or manually from this panel.`,
      });
    }
    load.forcedStatus = body.forcedStatus; // 'on' | 'off' | null
  }

  sendJSON(res, 200, { ok: true, ...currentSnapshot() });
};

// ---------- EcoSync AI endpoints ----------
// All four read the SAME real context (aiContext.buildEnergyContext) that
// backs the rest of the dashboard — nothing here invents its own numbers.
// /api/ai/recommendations, /api/ai/forecast, and /api/ai/schedule all
// degrade gracefully to a rule-based/template response if GROQ_API_KEY
// isn't set or the Groq call fails, so the dashboard's AI card and
// narrative panels never go blank just because a key is missing or the
// demo room has no internet. /api/chat requires a working key, since a
// free-form assistant has no non-AI fallback that would be honest.

api['POST /api/chat'] = async (req, res) => {
  if (!checkAiRateLimit(req)) {
    return sendJSON(res, 429, { error: 'Too many AI requests — please wait a moment and try again.', code: 'rate_limit' });
  }
  const body = await readJSONBody(req).catch(() => null);
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return sendJSON(res, 400, { error: 'A non-empty "message" string is required.' });
  }
  const message = body.message.trim().slice(0, 2000);
  const history = sanitizeHistory(body.history);
  try {
    // Routed through the Copilot agent: it plans which deterministic tools to
    // run, executes them, and only then asks a model to explain the results.
    // The response keeps its original { reply, dataSource, aiProvider } shape
    // so any existing client keeps working, and adds the confidence rating,
    // tool trace and structured data the upgraded UI renders.
    const out = await aiAgent.ask(message, history);
    sendJSON(res, 200, out);
  } catch (err) {
    // Last-resort safety net: never let the chat endpoint 500 when the
    // deterministic engine could still answer.
    try {
      const context = aiContext.buildEnergyContext();
      const reply = await aiService.chat(message, context, history);
      sendJSON(res, 200, { reply, dataSource: context.dataSource, aiProvider: aiService.providerStatus().active, answeredBy: 'legacy-fallback' });
    } catch (_) {
      sendAIError(res, err);
    }
  }
};

// ===========================================================================
// ECOSYNC AI COPILOT ROUTES
// ---------------------------------------------------------------------------
// Split deliberately into two tiers:
//   * /api/analytics/*, /api/anomalies, /api/whatif, /api/report, /api/memory
//     are DETERMINISTIC. They never call a model, never need an API key, and
//     always work offline. The dashboard's AI features are built on these.
//   * /api/ai/ask is the agent: it plans, runs those same tools, and then asks
//     a model to explain the results. With no provider configured it falls
//     back to a deterministic summary rather than failing.
// ===========================================================================

// --- Deterministic analytics -----------------------------------------------
api['GET /api/analytics/overview'] = (req, res) => {
  sendJSON(res, 200, {
    day: analytics.projectDay(),
    score: analytics.energyScore(),
    baseLoad: analytics.estimateBaseLoad(),
    comparison: analytics.comparePeriods(),
  });
};

api['GET /api/analytics/appliances'] = (req, res) => sendJSON(res, 200, analytics.applianceBreakdown());
api['GET /api/analytics/cost'] = (req, res) => sendJSON(res, 200, analytics.costAnalysis());
api['GET /api/analytics/score'] = (req, res) => sendJSON(res, 200, analytics.energyScore());
api['GET /api/analytics/standby'] = (req, res) => sendJSON(res, 200, analytics.estimateBaseLoad());

api['GET /api/analytics/history'] = (req, res) => {
  const hours = Number(url.parse(req.url, true).query.hours);
  sendJSON(res, 200, analytics.observedWindow(Number.isFinite(hours) ? hours : null));
};

api['GET /api/anomalies'] = (req, res) => sendJSON(res, 200, anomalyEngine.detect());

// Insights Center: the rule engine's recommendations, the anomaly findings and
// the concrete savings levers, merged into one categorised feed.
api['GET /api/insights'] = (req, res) => {
  try {
    const ctx = aiContext.buildEnergyContext();
    const recs = insightEngine.buildRecommendations(ctx);
    const findings = anomalyEngine.detect();
    const apps = analytics.applianceBreakdown();
    const score = analytics.energyScore();
    const day = analytics.projectDay();
    const baseLoad = analytics.estimateBaseLoad();
    const cfg = settingsModule.getSettings();

    const insights = [];

    recs.forEach((r, i) => insights.push({
      id: `rec-${i}`, category: 'daily', title: r.recommendation,
      explanation: r.reason, supportingData: { status: r.status },
      impact: r.priority === 'high' ? 'High' : r.priority === 'medium' ? 'Medium' : 'Low',
      recommendedAction: r.recommendation,
      confidence: { value: r.confidence, label: r.confidence >= 0.75 ? 'high' : r.confidence >= 0.55 ? 'medium' : 'low', reason: 'Produced by EcoSync\u2019s deterministic rule engine from the current snapshot.' },
      basis: 'observed',
    }));

    (findings.anomalies || []).forEach((a) => insights.push({
      id: `anom-${a.id}`, category: 'anomalies', title: a.title,
      explanation: a.explanation,
      supportingData: { expected: a.expected, actual: a.actual, difference: a.difference, unit: a.unit, time: a.time, affected: a.affected },
      impact: a.severity === 'attention' ? 'High' : a.severity === 'warning' ? 'Medium' : 'Low',
      recommendedAction: a.recommendedAction, confidence: a.confidence, basis: a.basis,
    }));

    const peakApps = apps.appliances.filter((a) => a.runsInPeak && !a.critical);
    if (peakApps.length) {
      const total = analytics.r2(peakApps.reduce((s, a) => s + a.estimatedCostRupeesPerDay, 0));
      insights.push({
        id: 'cost-peak', category: 'cost',
        title: `${peakApps.length} flexible load(s) run inside the peak tariff window`,
        explanation: `${peakApps.map((a) => a.name).join(', ')} run between ${cfg.tariff.peakStartHour}:00 and ${cfg.tariff.peakEndHour}:00, charged at \u20b9${cfg.tariff.peakRatePerKwh}/kWh instead of \u20b9${cfg.tariff.normalRatePerKwh}/kWh.`,
        supportingData: { exposedCostPerDay: total, peakRate: cfg.tariff.peakRatePerKwh, normalRate: cfg.tariff.normalRatePerKwh },
        impact: total > 20 ? 'High' : 'Medium',
        recommendedAction: 'Run the Smart Load optimizer to move them into a cheaper, higher-solar window.',
        confidence: { value: 0.8, label: 'high', reason: 'Computed from the configured schedule and tariff.' },
        basis: 'modelled',
      });
    }

    if (baseLoad.baseLoadSharePct > 25) {
      insights.push({
        id: 'eff-standby', category: 'efficiency',
        title: `Always-on base load is ${baseLoad.baseLoadSharePct}% of daily energy`,
        explanation: `${baseLoad.baseLoadKw} kW never switches off, consuming ${baseLoad.baseLoadKwhPerDay} kWh/day before any scheduled appliance runs.`,
        supportingData: { baseLoadKw: baseLoad.baseLoadKw, kwhPerDay: baseLoad.baseLoadKwhPerDay, sharePct: baseLoad.baseLoadSharePct },
        impact: 'Medium',
        recommendedAction: 'Audit continuously-powered equipment for standby waste.',
        confidence: { value: 0.6, label: 'medium', reason: 'Derived from the building demand profile, not per-circuit metering.' },
        basis: 'modelled',
      });
    }

    const exportGap = cfg.tariff.normalRatePerKwh - cfg.tariff.solarExportRatePerKwh;
    if (day.gridExportKwh > 1 && exportGap > 0) {
      insights.push({
        id: 'solar-export', category: 'solar',
        title: `${day.gridExportKwh} kWh/day of solar is exported rather than used on site`,
        explanation: `Export pays \u20b9${cfg.tariff.solarExportRatePerKwh}/kWh while importing costs \u20b9${cfg.tariff.normalRatePerKwh}/kWh, so every exported unit is worth \u20b9${analytics.r2(exportGap)} less than one consumed on site.`,
        supportingData: { exportedKwh: day.gridExportKwh, valueGapPerKwh: analytics.r2(exportGap), potentialPerDay: analytics.r2(day.gridExportKwh * exportGap) },
        impact: day.gridExportKwh * exportGap > 20 ? 'High' : 'Medium',
        recommendedAction: 'Shift a flexible load into the surplus window, or increase storage, to self-consume more.',
        confidence: { value: 0.7, label: 'medium', reason: 'Based on the modelled daily surplus profile.' },
        basis: 'projection',
      });
    }

    insights.push({
      id: 'score-weakest', category: 'efficiency',
      title: `Weakest efficiency component: ${score.weakest.label} (${score.weakest.score}/100)`,
      explanation: score.weakest.explanation,
      supportingData: { overallScore: score.score, grade: score.grade, componentWeight: score.weakest.weight },
      impact: score.weakest.score < 40 ? 'High' : 'Medium',
      recommendedAction: 'Improving this component moves the overall score most per unit of effort, given its weight.',
      confidence: { value: score.confidence === 'high' ? 0.85 : score.confidence === 'medium' ? 0.65 : 0.45, label: score.confidence, reason: score.confidenceReason },
      basis: score.weakest.basis,
    });

    const byCategory = {};
    insights.forEach((i) => { (byCategory[i.category] = byCategory[i.category] || []).push(i); });

    sendJSON(res, 200, {
      generatedAt: new Date().toISOString(),
      dataSource: ctx.dataSource,
      count: insights.length,
      categories: Object.keys(byCategory),
      byCategory,
      insights,
    });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || 'Could not build insights.' });
  }
};

api['GET /api/report'] = (req, res) => {
  const q = url.parse(req.url, true).query;
  const out = reportEngine.generate(q.period || 'daily', { days: q.days });
  sendJSON(res, out.available === false ? 400 : 200, out);
};

api['POST /api/whatif'] = async (req, res) => {
  const body = await readJSONBody(req).catch(() => null);
  if (!body || !body.type) {
    return sendJSON(res, 400, { error: 'A scenario "type" is required.', supported: ['reduce_appliance_hours', 'shift_appliance', 'tariff_change', 'change_solar', 'change_battery', 'avoid_peak'] });
  }
  const out = whatif.run(body);
  sendJSON(res, out.available === false ? 400 : 200, out);
};

// --- Transparent, editable AI memory ---------------------------------------
api['GET /api/memory'] = (req, res) => sendJSON(res, 200, memory.describe());

api['POST /api/memory'] = async (req, res) => {
  const body = await readJSONBody(req).catch(() => null);
  if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'A JSON object of preferences is required.' });
  if (body.clear) return sendJSON(res, 200, { ...memory.remove(body.clear === true ? '*' : body.clear), describe: memory.describe() });
  const out = memory.set(body);
  sendJSON(res, 200, { ...out, describe: memory.describe() });
};

// --- The agent --------------------------------------------------------------
api['GET /api/ai/tools'] = (req, res) => sendJSON(res, 200, { count: aiTools.list().length, tools: aiTools.list() });

// Quick actions call a single named tool directly. This is deliberate: a button
// with a fixed purpose should not pay for an LLM planning round-trip, and its
// result is identical with or without a provider configured.
api['POST /api/ai/tool'] = async (req, res) => {
  const body = await readJSONBody(req).catch(() => null);
  if (!body || !body.tool) return sendJSON(res, 400, { error: 'A "tool" name is required.', available: aiTools.list().map((t) => t.name) });
  if (!aiTools.has(body.tool)) return sendJSON(res, 404, { error: `Unknown tool "${body.tool}".`, available: aiTools.list().map((t) => t.name) });
  sendJSON(res, 200, aiTools.execute(body.tool, body.args || {}));
};

api['POST /api/ai/ask'] = async (req, res) => {
  if (!checkAiRateLimit(req)) {
    return sendJSON(res, 429, { error: 'Too many AI requests \u2014 please wait a moment and try again.', code: 'rate_limit' });
  }
  const body = await readJSONBody(req).catch(() => null);
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return sendJSON(res, 400, { error: 'A non-empty "message" string is required.' });
  }
  try {
    const out = await aiAgent.ask(body.message.trim().slice(0, 2000), sanitizeHistory(body.history));
    sendJSON(res, 200, out);
  } catch (err) {
    sendAIError(res, err);
  }
};

api['GET /api/ai/health'] = (req, res) => {
  const status = aiService.providerStatus();
  const configured = Object.entries(status.configured).filter(([, v]) => v).map(([k]) => k);
  sendJSON(res, 200, {
    providersConfigured: configured,
    providerCount: configured.length,
    activeProvider: status.active,
    fallbackOrder: status.order,
    deterministicFallback: true,
    toolCount: aiTools.list().length,
    note: configured.length
      ? 'External providers are configured. If all fail, EcoSync answers from its deterministic analysis engine instead.'
      : 'No external AI provider is configured. EcoSync answers from its deterministic analysis engine \u2014 every feature still works, but replies are templated rather than conversational.',
  });
};

api['POST /api/ai/recommendations'] = async (req, res) => {
  if (!checkAiRateLimit(req)) {
    return sendJSON(res, 429, { error: 'Too many AI requests — please wait a moment and try again.', code: 'rate_limit' });
  }
  try {
    const context = aiContext.buildEnergyContext();
    const recommendations = insightEngine.buildRecommendations(context);
    let headline = null;
    let headlineSource = 'rule-engine';
    if (aiService.isConfigured()) {
      try {
        headline = (await aiService.narrateRecommendations(context, recommendations)).trim();
        headlineSource = aiService.providerStatus().active;
      } catch (err) {
        headline = null; // fall through to rule-based headline below
      }
    }
    if (!headline) {
      headline = recommendations[0] ? recommendations[0].recommendation : 'No notable energy events right now — everything is within the expected range.';
    }
    sendJSON(res, 200, { recommendations, headline, headlineSource, dataSource: context.dataSource });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || 'Could not compute recommendations.' });
  }
};

api['POST /api/ai/forecast'] = async (req, res) => {
  if (!checkAiRateLimit(req)) {
    return sendJSON(res, 429, { error: 'Too many AI requests — please wait a moment and try again.', code: 'rate_limit' });
  }
  try {
    const context = aiContext.buildEnergyContext();
    const forecast = forecastEngine.forecastNext24(hourFloat(), state.history);
    let narrative = null;
    let narrativeSource = 'rule-engine';
    if (aiService.isConfigured()) {
      try {
        narrative = (await aiService.narrateForecast(context, forecast.points)).trim();
        narrativeSource = aiService.providerStatus().active;
      } catch (err) {
        narrative = null;
      }
    }
    if (!narrative) {
      const peakSolar = forecast.points.reduce((a, b) => (b.solar > a.solar ? b : a), forecast.points[0]);
      const peakDemand = forecast.points.reduce((a, b) => (b.demand > a.demand ? b : a), forecast.points[0]);
      narrative = `Solar is expected to peak around ${peakSolar.hourLabel} (~${peakSolar.solar} kW) and demand around ${peakDemand.hourLabel} (~${peakDemand.demand} kW), based on ${forecast.engine}.`;
    }
    sendJSON(res, 200, { forecast, narrative, narrativeSource });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || 'Could not compute forecast.' });
  }
};

api['POST /api/ai/schedule'] = async (req, res) => {
  if (!checkAiRateLimit(req)) {
    return sendJSON(res, 429, { error: 'Too many AI requests — please wait a moment and try again.', code: 'rate_limit' });
  }
  const body = await readJSONBody(req).catch(() => ({}));
  try {
    const gridPrice = body.gridPrice ?? state.gridPrice;
    const forecast = forecastEngine.forecastNext24(hourFloat(), state.history);
    // NOTE: unlike POST /api/schedule, this is read-only — it does not write
    // scheduledStart back onto state.loads. It's a preview/explanation for
    // "Ask EcoSync AI", not a way to commit a new schedule.
    const result = scheduler.optimizeSchedule(state.loads, forecast.points, gridPrice);
    const context = aiContext.buildEnergyContext();
    let narrative = null;
    let narrativeSource = 'rule-engine';
    if (aiService.isConfigured()) {
      try {
        narrative = (await aiService.narrateSchedule(context, result)).trim();
        narrativeSource = aiService.providerStatus().active;
      } catch (err) {
        narrative = null;
      }
    }
    if (!narrative) {
      narrative = `Optimizing all flexible loads against the solar forecast captures ${result.totals.renewableUsed} kWh more renewable energy and saves an estimated ₹${result.totals.costSaved}.`;
    }
    sendJSON(res, 200, { ...result, narrative, narrativeSource });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || 'Could not compute schedule.' });
  }
};

function resetDemo() {
  state.simSeconds = 6 * 3600; // 06:00
  state.batterySoC = 40;
  state.history = [];
  state.alerts = [];
  state.cumulative = {
    demandTotal: 0, renewableServed: 0, renewableServedBaseline: 0,
    gridImport: 0, gridImportBaseline: 0, costActual: 0, costBaseline: 0,
    exportRevenue: 0, solarSavings: 0,
    peakDemandActual: 0, peakDemandBaseline: 0,
  };
  state.loads.forEach((l) => { l.scheduledStart = null; l.forcedStatus = null; });
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------- request dispatch ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const key = `${req.method} ${parsed.pathname}`;

  if (parsed.pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    const handler = api[key];
    if (!handler) return sendJSON(res, 404, { error: 'Unknown endpoint' });
    try {
      await handler(req, res);
    } catch (err) {
      console.error(err);
      sendJSON(res, 500, { error: 'Internal error', detail: String(err.message || err) });
    }
    return;
  }

  serveStatic(req, res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`EcoSync backend running at http://localhost:${PORT}`);
});
