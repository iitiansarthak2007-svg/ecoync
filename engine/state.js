// engine/state.js
// The single source of truth for EcoSync's simulated campus.
// Everything the API returns is derived from this module — nothing in
// the routes layer invents its own numbers.

const { solarProfile, demandProfile } = require('./profiles');
const optimization = require('./optimization');
const settings = require('./settings');
const liveProvider = require('./liveProvider');

// These read live from engine/settings.js (Settings page) so they always
// reflect the operator's current configuration rather than a fixed build-time value.
function getBatteryCapacityKwh() { return settings.getSettings().battery.capacityKwh; }
function getBatteryMinReservePct() { return settings.getSettings().battery.minReservePct; }
function getBatteryMaxRateKw() { return settings.getSettings().battery.maxRateKw; }
function getCO2FactorKgPerKwh() { return settings.getSettings().gridEmissionFactorKgPerKwh; }

const ACCEL_AMBIENT = 180; // 1 real second = 180 simulated seconds (~24h cycle every 8 real minutes)
const ACCEL_DEMO = 480; // faster, scripted playback for a live demo

const DEFAULT_LOADS = [
  { id: 'ev', name: 'EV Charging', power: 3.3, duration: 2, priority: 'medium', earliestStart: 0, latestFinish: 24, baselineStart: 18, critical: false },
  { id: 'pump', name: 'Water Pump', power: 1.1, duration: 1, priority: 'low', earliestStart: 6, latestFinish: 20, baselineStart: 7, critical: false },
  { id: 'laundry', name: 'Laundry', power: 2.2, duration: 1, priority: 'low', earliestStart: 8, latestFinish: 22, baselineStart: 19, critical: false },
  { id: 'hvac', name: 'HVAC', power: 2.8, duration: 4, priority: 'high', earliestStart: 0, latestFinish: 24, baselineStart: 13, critical: true },
];

const DEVICES = [
  { id: 'main-meter-01', name: 'Main Energy Meter', location: 'Substation' },
  { id: 'solar-meter-01', name: 'Solar Meter', location: 'Rooftop Array' },
  { id: 'battery-sensor-01', name: 'Battery Sensor', location: 'Battery Room' },
  { id: 'esp32-gw-01', name: 'ESP32 Gateway', location: 'Hostel Block C' },
];

function freshState() {
  const now = new Date();
  const nowHour = now.getHours() + now.getMinutes() / 60;
  return {
    simSeconds: nowHour * 3600,
    mode: 'AMBIENT', // 'AMBIENT' | 'DEMO'
    demoStatus: 'idle', // 'idle' | 'running' | 'paused'
    overrideMode: 'AUTO', // 'AUTO' | 'MANUAL'
    dataSource: 'DEMO SIMULATION', // architecture also supports 'LIVE SENSOR' via a future MQTTDataProvider
    manualScenario: null, // { solar, demand, batterySoc, gridPrice, solarAvailable, batteryAvailable, gridAvailable }
    gridPrice: 8,
    batterySoC: 55,
    loads: DEFAULT_LOADS.map((l) => ({ ...l, scheduledStart: null, forcedStatus: null })),
    history: [],
    alerts: [],
    cumulative: {
      demandTotal: 0,
      renewableServed: 0,
      renewableServedBaseline: 0,
      gridImport: 0,
      gridImportBaseline: 0,
      costActual: 0,
      costBaseline: 0,
      exportRevenue: 0,
      solarSavings: 0,
      peakDemandActual: 0,
      peakDemandBaseline: 0,
    },
    lastDecision: null,
    lastUpdated: null,
  };
}

let state = freshState();

function hourFloat() {
  return (state.simSeconds / 3600) % 24;
}

function activeLoadPowerAt(hour, useScheduled) {
  let total = 0;
  for (const load of state.loads) {
    if (load.forcedStatus === 'off') continue;
    const start = useScheduled && load.scheduledStart != null ? load.scheduledStart : load.baselineStart;
    const h = ((hour - start) + 24) % 24;
    if (h < load.duration || load.forcedStatus === 'on') total += load.power;
  }
  return Math.round(total * 100) / 100;
}

function pushHistory(point) {
  state.history.push(point);
  if (state.history.length > 180) state.history.shift();
}

function pushAlert(alert) {
  state.alerts.unshift({ id: `a-${Date.now()}-${Math.round(Math.random() * 999)}`, ...alert });
  if (state.alerts.length > 30) state.alerts.length = 30;
}

function detectAnomalies(hour, solar, demand, expectedSolar, expectedDemand, gridImport) {
  const stamp = clockLabel();
  if (expectedSolar > 1 && solar < expectedSolar * 0.55 && hour > 7 && hour < 17) {
    pushAlert({
      severity: 'attention',
      time: stamp,
      source: 'Solar Meter',
      description: `Solar output is ${Math.round((1 - solar / expectedSolar) * 100)}% below the expected profile for this hour.`,
      recommendedAction: 'Check for panel shading, soiling, or an inverter fault.',
    });
  }
  if (demand > expectedDemand * 1.4) {
    pushAlert({
      severity: 'warning',
      time: stamp,
      source: 'Main Energy Meter',
      description: `Demand (${demand.toFixed(1)} kW) is well above the expected level (${expectedDemand.toFixed(1)} kW) for this hour.`,
      recommendedAction: 'Check for an unscheduled high-draw load.',
    });
  }
  if (gridImport > 0.2 && solar > demand) {
    pushAlert({
      severity: 'info',
      time: stamp,
      source: 'Main Energy Meter',
      description: 'Unexpected grid import detected while solar generation exceeds demand.',
      recommendedAction: 'Check battery availability and charge controller status.',
    });
  }
  if (state.history.length >= 3) {
    const recent = state.history.slice(-3);
    const drop = recent[0].battery - recent[2].battery;
    if (drop > 15) {
      pushAlert({
        severity: 'warning',
        time: stamp,
        source: 'Battery Sensor',
        description: `Battery state of charge dropped ${Math.round(drop)}% over the last few readings.`,
        recommendedAction: 'Verify discharge rate against connected loads.',
      });
    }
  }
}

function clockLabel() {
  const h = hourFloat();
  const hh = String(Math.floor(h)).padStart(2, '0');
  const mm = String(Math.floor((h % 1) * 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}

function tick(deltaRealSeconds) {
  // Settings > "Simulation speed (×)" scales how fast simulated time moves
  // in normal AMBIENT mode (e.g. 2x makes a full day cycle in ~4 real
  // minutes instead of ~8). DEMO mode intentionally ignores it and always
  // runs at ACCEL_DEMO so a scripted SIH walkthrough has a predictable,
  // repeatable pace regardless of what an operator left the setting at.
  const speedMultiplier = Math.max(0.1, settings.getSettings().simulationSpeedMultiplier || 1);
  let accel = ACCEL_AMBIENT * speedMultiplier;
  if (state.mode === 'DEMO') {
    accel = state.demoStatus === 'running' ? ACCEL_DEMO : 0;
  }
  state.simSeconds += deltaRealSeconds * accel;
  if (state.mode === 'DEMO' && hourFloat() >= 22 && state.demoStatus === 'running') {
    state.demoStatus = 'paused'; // scripted demo day ends at 22:00
  }
  const deltaHours = (deltaRealSeconds * accel) / 3600;
  const hour = hourFloat();

  const scenario = state.manualScenario;
  const solarAvailable = scenario ? scenario.solarAvailable !== false : true;
  const batteryAvailable = scenario ? scenario.batteryAvailable !== false : true;
  const gridAvailable = scenario ? scenario.gridAvailable !== false : true;

  const cfg = settings.getSettings();
  const expectedSolar = solarProfile(hour);
  const expectedDemandBase = demandProfile(hour) * (cfg.buildingProfileScale || 1);

  // Priority for where a reading comes from: manual scenario override (for
  // the Scenario Simulator / judge what-if demo) > a live external API >
  // the built-in simulator. This is also how state.dataSource is derived.
  const liveReading = scenario ? null : liveProvider.getLiveReading();

  const solar = solarAvailable
    ? (scenario && scenario.solar != null ? scenario.solar : liveReading ? liveReading.solar : expectedSolar)
    : 0;
  const baseDemand = scenario && scenario.demand != null
    ? scenario.demand
    : liveReading ? liveReading.demand : expectedDemandBase;

  if (scenario && scenario.batterySoc != null) state.batterySoC = scenario.batterySoc;
  else if (liveReading && liveReading.batterySoC != null) state.batterySoC = liveReading.batterySoC;

  const tariffNow = scenario && scenario.gridPrice != null ? scenario.gridPrice : settings.tariffRateAt(hour, cfg);
  state.gridPrice = tariffNow;

  state.dataSource = scenario
    ? 'MANUAL SCENARIO OVERRIDE'
    : liveReading
    ? 'LIVE API'
    : liveProvider.isConfigured()
    ? 'SIMULATION (live API configured but unreachable — auto fallback)'
    : 'DEMO SIMULATION';

  const flexActual = activeLoadPowerAt(hour, true);
  const flexBaseline = activeLoadPowerAt(hour, false);
  const demand = Math.round((baseDemand + flexActual) * 100) / 100;
  const baselineDemand = Math.round((expectedDemandBase + flexBaseline) * 100) / 100;

  const BATTERY_CAPACITY_KWH = getBatteryCapacityKwh();
  const BATTERY_MIN_RESERVE_PCT = getBatteryMinReservePct();
  const BATTERY_MAX_RATE_KW = getBatteryMaxRateKw();

  const decision = optimization.decide({
    solar,
    demand,
    batterySoC: state.batterySoC,
    minReserve: BATTERY_MIN_RESERVE_PCT,
    batteryAvailable,
    gridAvailable,
  });

  // --- Real energy flow bookkeeping (actual / "with EcoSync") ---
  let solarToLoad = Math.min(solar, demand);
  let batteryDelta = 0; // kW, positive = charging
  let gridImport = 0;
  let gridExport = 0;
  const net = solar - demand;

  if (net >= 0) {
    if (batteryAvailable && state.batterySoC < 99) {
      const roomKwh = ((100 - state.batterySoC) / 100) * BATTERY_CAPACITY_KWH;
      const chargeKw = Math.min(net, BATTERY_MAX_RATE_KW, roomKwh / Math.max(deltaHours, 1e-6));
      batteryDelta = chargeKw;
      const leftover = net - chargeKw;
      if (leftover > 0.01 && gridAvailable) gridExport = leftover;
    } else if (gridAvailable) {
      gridExport = net;
    }
  } else {
    const deficit = -net;
    if (batteryAvailable && state.batterySoC > BATTERY_MIN_RESERVE_PCT) {
      const availableKwh = ((state.batterySoC - BATTERY_MIN_RESERVE_PCT) / 100) * BATTERY_CAPACITY_KWH;
      const dischargeKw = Math.min(deficit, BATTERY_MAX_RATE_KW, availableKwh / Math.max(deltaHours, 1e-6));
      batteryDelta = -dischargeKw;
      const remaining = deficit - dischargeKw;
      if (remaining > 0.01 && gridAvailable) gridImport = remaining;
    } else if (gridAvailable) {
      gridImport = deficit;
    }
  }

  state.batterySoC = Math.min(100, Math.max(0, state.batterySoC + (batteryDelta * deltaHours * 100) / BATTERY_CAPACITY_KWH));
  state.batterySoC = Math.round(state.batterySoC * 10) / 10;

  const renewableServedNow = solarToLoad + Math.max(0, -batteryDelta); // solar direct + battery discharge assumed solar-charged
  const exportRate = cfg.tariff.solarExportRatePerKwh;
  state.cumulative.demandTotal += demand * deltaHours;
  state.cumulative.renewableServed += renewableServedNow * deltaHours;
  state.cumulative.gridImport += gridImport * deltaHours;
  state.cumulative.costActual += gridImport * deltaHours * tariffNow;
  state.cumulative.exportRevenue = (state.cumulative.exportRevenue || 0) + gridExport * deltaHours * exportRate;
  state.cumulative.solarSavings = (state.cumulative.solarSavings || 0) + renewableServedNow * deltaHours * tariffNow;
  state.cumulative.peakDemandActual = Math.max(state.cumulative.peakDemandActual, demand);

  // --- Baseline bookkeeping ("without EcoSync": direct solar use only, no battery mediation, loads at their original/default times) ---
  const baselineSolarToLoad = Math.min(solar, baselineDemand);
  const baselineGridImport = Math.max(0, baselineDemand - baselineSolarToLoad);
  state.cumulative.renewableServedBaseline += baselineSolarToLoad * deltaHours;
  state.cumulative.gridImportBaseline += baselineGridImport * deltaHours;
  state.cumulative.costBaseline += baselineGridImport * deltaHours * tariffNow;
  state.cumulative.peakDemandBaseline = Math.max(state.cumulative.peakDemandBaseline, baselineDemand);

  detectAnomalies(hour, solar, demand, expectedSolar, expectedDemandBase, gridImport);

  pushHistory({
    t: Date.now(),
    hour: Math.round(hour * 100) / 100,
    hourLabel: clockLabel(),
    solar,
    demand,
    battery: state.batterySoC,
    gridImport: Math.round(gridImport * 100) / 100,
    gridExport: Math.round(gridExport * 100) / 100,
    decision: decision.decision,
  });

  state.lastDecision = decision;
  state.lastUpdated = new Date().toISOString();

  return {
    hour,
    solar,
    demand,
    batterySoC: state.batterySoC,
    gridImport: Math.round(gridImport * 100) / 100,
    gridExport: Math.round(gridExport * 100) / 100,
    batteryDelta: Math.round(batteryDelta * 100) / 100,
    decision,
  };
}

function currentSnapshot() {
  const h = hourFloat();
  const last = state.history[state.history.length - 1];
  const co2Factor = getCO2FactorKgPerKwh();
  const daysElapsed = Math.max(state.simSeconds / 86400, 1 / 24);
  const netCostSoFar = state.cumulative.costActual - (state.cumulative.exportRevenue || 0);
  return {
    dataSource: state.dataSource,
    mode: state.mode,
    demoStatus: state.demoStatus,
    overrideMode: state.overrideMode,
    hour: Math.round(h * 100) / 100,
    hourLabel: clockLabel(),
    lastUpdated: state.lastUpdated,
    solar: last ? last.solar : 0,
    demand: last ? last.demand : 0,
    batterySoC: state.batterySoC,
    gridImport: last ? last.gridImport : 0,
    gridExport: last ? last.gridExport : 0,
    renewableUtilizationPct: state.cumulative.demandTotal > 0
      ? Math.round((state.cumulative.renewableServed / state.cumulative.demandTotal) * 100)
      : 0,
    energyCostSoFar: Math.round(state.cumulative.costActual * 100) / 100,
    netCostSoFar: Math.round(netCostSoFar * 100) / 100,
    exportRevenueSoFar: Math.round((state.cumulative.exportRevenue || 0) * 100) / 100,
    solarSavingsSoFar: Math.round((state.cumulative.solarSavings || 0) * 100) / 100,
    potentialSavingsSoFar: Math.round((state.cumulative.costBaseline - state.cumulative.costActual) * 100) / 100,
    estimatedMonthlyCost: Math.round((netCostSoFar / daysElapsed) * 30 * 100) / 100,
    co2ReductionKg: Math.round(
      (state.cumulative.gridImportBaseline - state.cumulative.gridImport) * co2Factor * 100
    ) / 100,
    decision: state.lastDecision,
    manualScenarioActive: !!state.manualScenario,
    gridPrice: state.gridPrice,
    liveApi: liveProvider.status(),
  };
}

module.exports = {
  state,
  getBatteryCapacityKwh,
  getBatteryMinReservePct,
  getBatteryMaxRateKw,
  getCO2FactorKgPerKwh,
  DEVICES,
  hourFloat,
  tick,
  currentSnapshot,
  clockLabel,
};
