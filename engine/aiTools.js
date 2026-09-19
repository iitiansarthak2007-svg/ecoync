// engine/aiTools.js
// EcoSync AI tool system.
//
// This is the layer that turns "a chatbot with a big JSON blob stapled to the
// prompt" into an actual agent. Each tool is a small, deterministic function
// over real application state, with a machine-readable description the planner
// uses to decide what to call.
//
// THE RULE: a tool computes, the model explains. No tool calls an LLM, and no
// number reaches the user without having come out of a tool first. If a tool
// cannot answer from real data it returns { available:false, reason } — which
// is exactly what lets the assistant say "I don't have that" instead of
// inventing a figure (STEP 21).

const analytics = require('./analytics');
const anomaly = require('./anomaly');
const whatif = require('./whatif');
const report = require('./report');
const memory = require('./memory');
const scheduler = require('./scheduler');
const forecastEngine = require('./forecast');
const settingsModule = require('./settings');
const { state, hourFloat, currentSnapshot, getBatteryCapacityKwh, getBatteryMinReservePct, getBatteryMaxRateKw } = require('./state');

// ---------------------------------------------------------------------------
// Tool definitions. `params` is documentation for the planner, not a validator
// — each run() defends itself.
// ---------------------------------------------------------------------------
const TOOLS = {

  getCurrentEnergy: {
    description: 'Live snapshot: solar, demand, grid import/export, battery SoC, tariff rate, current optimizer decision. Use for any "right now" question.',
    params: {},
    run() {
      const s = currentSnapshot();
      const cfg = settingsModule.getSettings();
      return {
        basis: 'observed',
        clock: s.hourLabel,
        dataSource: s.dataSource,
        solarKw: s.solar,
        demandKw: s.demand,
        netBalanceKw: analytics.r2(s.solar - s.demand),
        gridImportKw: s.gridImport,
        gridExportKw: s.gridExport,
        batterySocPct: s.batterySoC,
        gridPricePerKwh: s.gridPrice,
        tariffPeriod: analytics.tariffPeriodAt(hourFloat(), cfg),
        peakWindow: `${cfg.tariff.peakStartHour}:00-${cfg.tariff.peakEndHour}:00`,
        renewableUtilizationPct: s.renewableUtilizationPct,
        currentDecision: s.decision,
      };
    },
  },

  getHistoricalEnergy: {
    description: 'Integrated totals from EcoSync\'s recorded readings. Optional hoursBack narrows the window. Returns available:false if too little history exists.',
    params: { hoursBack: 'number, optional — simulated hours to look back' },
    run(args = {}) {
      return analytics.observedWindow(args.hoursBack != null ? Number(args.hoursBack) : null);
    },
  },

  getDailyEnergy: {
    description: 'Full 24-hour modelled day: energy, cost, peak, hourly curve, energy split by tariff band. A projection, not a measurement.',
    params: {},
    run() { return analytics.projectDay(); },
  },

  getWeeklyEnergy: {
    description: '7-day projection built from the daily model. Explicitly NOT measured history — EcoSync does not retain a week of actuals.',
    params: {},
    run() { return analytics.projectPeriod(7); },
  },

  getMonthlyEnergy: {
    description: '30-day projection built from the daily model. Explicitly NOT measured history.',
    params: {},
    run() { return analytics.projectPeriod(30); },
  },

  getApplianceData: {
    description: 'Per-appliance energy, cost, solar coverage, peak-window exposure and share of daily energy, derived from the configured load model.',
    params: {},
    run() { return analytics.applianceBreakdown(); },
  },

  getStandbyAnalysis: {
    description: 'Always-on base load: kW, kWh/day, share of daily energy, overnight consumption. Use for "energy waste" and standby questions.',
    params: {},
    run() { return analytics.estimateBaseLoad(); },
  },

  getSolarData: {
    description: 'Solar generation now, projected daily generation, self-consumed vs exported, and the export rate.',
    params: {},
    run() {
      const s = currentSnapshot();
      const day = analytics.projectDay();
      const cfg = settingsModule.getSettings();
      return {
        basis: 'mixed',
        currentSolarKw: s.solar,
        currentDemandKw: s.demand,
        surplusKw: analytics.r2(s.solar - s.demand),
        projectedDailyGenerationKwh: day.solarGeneratedKwh,
        projectedSelfConsumedKwh: day.solarToLoadKwh,
        projectedExportedKwh: day.gridExportKwh,
        exportRatePerKwh: cfg.tariff.solarExportRatePerKwh,
        importRateNowPerKwh: s.gridPrice,
        note: 'Solar is modelled by a deterministic clear-day profile. EcoSync has no weather feed, so it cannot account for actual cloud cover.',
      };
    },
  },

  getBatteryData: {
    description: 'Battery state of charge, capacity, reserve, rate limits, usable energy, headroom, and projected daily contribution.',
    params: {},
    run() {
      const s = currentSnapshot();
      const day = analytics.projectDay();
      const cap = getBatteryCapacityKwh();
      const reserve = getBatteryMinReservePct();
      return {
        basis: 'mixed',
        socPct: s.batterySoC,
        capacityKwh: cap,
        minReservePct: reserve,
        maxRateKw: getBatteryMaxRateKw(),
        usableAboveReserveKwh: analytics.r2(Math.max(0, (s.batterySoC - reserve) / 100) * cap),
        headroomKwh: analytics.r2(((100 - s.batterySoC) / 100) * cap),
        projectedDailyEnergyServedKwh: day.batteryToLoadKwh,
        canDischarge: s.batterySoC > reserve,
        canCharge: s.batterySoC < 99,
      };
    },
  },

  getTariffData: {
    description: 'Full tariff structure, the rate right now, which band the current hour falls in, and the peak window.',
    params: {},
    run() {
      const cfg = settingsModule.getSettings();
      const s = currentSnapshot();
      return {
        basis: 'configured',
        tariff: cfg.tariff,
        currentRatePerKwh: s.gridPrice,
        currentPeriod: analytics.tariffPeriodAt(hourFloat(), cfg),
        peakWindow: `${cfg.tariff.peakStartHour}:00-${cfg.tariff.peakEndHour}:00`,
        clock: s.hourLabel,
      };
    },
  },

  getForecast: {
    description: 'Solar/demand forecast with per-point confidence. horizon: "next_hour" | "6h" | "24h". Includes predicted peak and the engine\'s stated method.',
    params: { horizon: 'string — next_hour | 6h | 24h (default 24h)' },
    run(args = {}) {
      const fc = forecastEngine.forecastNext24(hourFloat(), state.history);
      const horizon = String(args.horizon || '24h').toLowerCase();
      const n = horizon === 'next_hour' ? 1 : horizon === '6h' ? 6 : 24;
      const pts = fc.points.slice(0, n);
      const peakSolar = pts.reduce((a, b) => (b.solar > a.solar ? b : a), pts[0]);
      const peakDemand = pts.reduce((a, b) => (b.demand > a.demand ? b : a), pts[0]);
      const cfg = settingsModule.getSettings();
      let cost = 0;
      pts.forEach((p) => { cost += Math.max(0, p.demand - p.solar) * settingsModule.tariffRateAt(p.hour, cfg); });
      return {
        basis: 'forecast',
        engine: fc.engine,
        method: 'Time-of-day profile blended with a moving average of recent actual readings. This is a transparent heuristic, NOT a trained machine-learning model.',
        horizon,
        points: pts,
        predictedPeakDemand: { hourLabel: peakDemand.hourLabel, kw: peakDemand.demand },
        predictedPeakSolar: { hourLabel: peakSolar.hourLabel, kw: peakSolar.solar },
        predictedGridCostRupees: analytics.r2(cost),
        confidenceRange: { nearest: pts[0].confidence, furthest: pts[pts.length - 1].confidence },
        confidenceNote: 'Confidence decays with distance because the heuristic has no weather input and only a short history buffer.',
        historyPointsUsed: state.history.length,
      };
    },
  },

  calculateEnergyCost: {
    description: 'Cost analysis: observed cost so far, projected full-day cost, split by tariff band, monthly projection, and which appliances sit in peak.',
    params: {},
    run() { return analytics.costAnalysis(); },
  },

  calculateSavings: {
    description: 'What EcoSync has saved versus a no-optimization baseline, plus the savings still available from re-scheduling.',
    params: {},
    run() {
      const s = currentSnapshot();
      const fc = forecastEngine.forecastNext24(hourFloat(), state.history);
      const sched = scheduler.optimizeSchedule(state.loads, fc.points, s.gridPrice);
      return {
        basis: 'mixed',
        realisedSoFar: {
          basis: 'observed',
          savingsVsBaselineRupees: s.potentialSavingsSoFar,
          solarSavingsRupees: s.solarSavingsSoFar,
          exportCreditRupees: s.exportRevenueSoFar,
          co2ReductionKg: s.co2ReductionKg,
          baselineDefinition: 'A campus with no battery mediation and no load scheduling, using solar only when it happens to coincide with demand.',
        },
        stillAvailable: {
          basis: 'projection',
          fromRescheduling: sched.totals,
          note: 'Produced by the same sliding-window optimizer the Smart Loads panel uses.',
        },
      };
    },
  },

  detectAnomalies: {
    description: 'Full anomaly scan with expected vs actual, difference, explanation, recommended action and confidence for each finding.',
    params: {},
    run() { return anomaly.detect(); },
  },

  optimizeSchedule: {
    description: 'Runs the load optimizer against the current forecast and returns before/after start times, renewable gain and cost saved per load.',
    params: {},
    run() {
      const s = currentSnapshot();
      const fc = forecastEngine.forecastNext24(hourFloat(), state.history);
      const res = scheduler.optimizeSchedule(state.loads, fc.points, s.gridPrice);
      return {
        basis: 'projection',
        method: 'Sliding-window maximum-solar search across each load\'s allowed window.',
        ...res,
        note: 'These are recommended start times. EcoSync does not control physical hardware — applying a schedule updates the simulation model only.',
      };
    },
  },

  comparePeriods: {
    description: 'Compares recorded readings against the expected profile for the same hours. Refuses week-over-week comparisons EcoSync cannot support.',
    params: { periodA: 'string', periodB: 'string' },
    run(args = {}) { return analytics.comparePeriods(args.periodA || 'recent', args.periodB || 'expected'); },
  },

  getEnergyScore: {
    description: 'Explainable efficiency score 0-100 with a weighted breakdown of all five components and its confidence.',
    params: {},
    run() { return analytics.energyScore(); },
  },

  runWhatIf: {
    description: 'Runs a scenario and returns current vs alternative with the difference and assumptions. type: reduce_appliance_hours | shift_appliance | tariff_change | change_solar | change_battery | avoid_peak.',
    params: {
      type: 'string — scenario type (required)',
      loadId: 'string — ev | pump | laundry | hvac',
      hours: 'number — for reduce_appliance_hours',
      startHour: 'number 0-23 — for shift_appliance',
      percent: 'number — for tariff_change',
      multiplier: 'number — for change_solar',
      capacityKwh: 'number — for change_battery',
    },
    run(args = {}) { return whatif.run(args); },
  },

  generateReport: {
    description: 'Builds a full structured report. period: daily | weekly | monthly | custom (with days).',
    params: { period: 'string', days: 'number — for custom' },
    run(args = {}) { return report.generate(args.period || 'daily', { days: args.days }); },
  },

  getAlerts: {
    description: 'Live operational alerts raised by the simulation as readings arrived.',
    params: {},
    run() {
      return {
        basis: 'observed',
        count: state.alerts.length,
        alerts: state.alerts.slice(0, 10).map((a) => ({ severity: a.severity, time: a.time, source: a.source, description: a.description, recommendedAction: a.recommendedAction })),
      };
    },
  },

  getUserPreferences: {
    description: 'The user\'s stored EcoSync preferences (budget, quiet hours, optimization priority). Check before giving personalised advice.',
    params: {},
    run() { return { basis: 'stored', preferences: memory.getAll(), isEmpty: !Object.keys(memory.getAll()).length }; },
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
function list() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, params: t.params }));
}

// Compact catalogue for the planner prompt.
function catalogueText() {
  return Object.entries(TOOLS)
    .map(([name, t]) => {
      const p = Object.keys(t.params || {}).length ? ` (args: ${Object.keys(t.params).join(', ')})` : '';
      return `- ${name}${p}: ${t.description}`;
    })
    .join('\n');
}

function has(name) { return Object.prototype.hasOwnProperty.call(TOOLS, name); }

function execute(name, args) {
  if (!has(name)) return { error: `Unknown tool "${name}".`, available: false };
  try {
    const started = Date.now();
    const result = TOOLS[name].run(args || {});
    return { ok: true, tool: name, args: args || {}, ms: Date.now() - started, result };
  } catch (err) {
    // A failing tool must degrade to "I don't have that", never to a crash.
    return { ok: false, tool: name, args: args || {}, error: err.message, result: { available: false, reason: `The ${name} tool failed: ${err.message}` } };
  }
}

function executeMany(calls) {
  const out = [];
  const seen = new Set();
  for (const call of (calls || []).slice(0, 6)) {
    const name = call && call.tool;
    if (!name || !has(name)) continue;
    const sig = name + JSON.stringify(call.args || {});
    if (seen.has(sig)) continue;   // never run the same tool twice in one turn
    seen.add(sig);
    out.push(execute(name, call.args));
  }
  return out;
}

module.exports = { TOOLS, list, catalogueText, execute, executeMany, has };
