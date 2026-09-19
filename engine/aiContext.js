// engine/aiContext.js
// Builds one structured snapshot of EcoSync's real (or clearly-labelled
// simulated) energy data for the AI layer to consume. This is the ONLY
// place the AI assistant is allowed to read energy data from — it never
// invents readings, so if a field isn't here, the AI is instructed (see
// aiService.js's system prompt) to say the data is unavailable rather than
// guess at it.

const {
  state, hourFloat, currentSnapshot,
  getBatteryCapacityKwh, getBatteryMinReservePct, getBatteryMaxRateKw, getCO2FactorKgPerKwh,
} = require('./state');
const forecastEngine = require('./forecast');
const settingsModule = require('./settings');
const memory = require('./memory');

function buildEnergyContext() {
  const dash = currentSnapshot();
  const forecast = forecastEngine.forecastNext24(hourFloat(), state.history);
  const cfg = settingsModule.getSettings();

  const isSimulated = /SIMULATION|MANUAL/.test(dash.dataSource);

  return {
    generatedAt: new Date().toISOString(),
    dataSource: dash.dataSource,
    isSimulatedOrDemoData: isSimulated,
    clock: dash.hourLabel,
    mode: dash.mode,
    current: {
      solarKw: dash.solar,
      demandKw: dash.demand,
      gridImportKw: dash.gridImport,
      gridExportKw: dash.gridExport,
      gridPricePerKwh: dash.gridPrice,
      renewableUtilizationPct: dash.renewableUtilizationPct,
    },
    battery: {
      socPct: dash.batterySoC,
      capacityKwh: getBatteryCapacityKwh(),
      minReservePct: getBatteryMinReservePct(),
      maxRateKw: getBatteryMaxRateKw(),
    },
    costs: {
      energyCostSoFarRupees: dash.energyCostSoFar,
      netCostSoFarRupees: dash.netCostSoFar,
      estimatedMonthlyCostRupees: dash.estimatedMonthlyCost,
      potentialSavingsSoFarRupees: dash.potentialSavingsSoFar,
      co2ReductionKgSoFar: dash.co2ReductionKg,
      co2FactorKgPerKwh: getCO2FactorKgPerKwh(),
    },
    // The real rule-based decision from engine/optimization.js — the AI
    // explains/discusses this, it does not override or replace it.
    currentDecision: dash.decision,
    derived: {
      solarBalanceKw: Math.round((dash.solar - dash.demand) * 100) / 100,
      batteryHeadroomKwh: Math.round(((100 - dash.batterySoC) / 100) * getBatteryCapacityKwh() * 100) / 100,
      batteryUsableAboveReserveKwh: Math.round(Math.max(0, (dash.batterySoC - getBatteryMinReservePct()) / 100) * getBatteryCapacityKwh() * 100) / 100,
      chargeHeadroomTo80PctKwh: Math.round(Math.max(0, 80 - dash.batterySoC) / 100 * getBatteryCapacityKwh() * 100) / 100,
      chargeTimeAtCurrentSurplusHours: (dash.solar > dash.demand && dash.batterySoC < 80)
        ? Math.round((Math.max(0, 80 - dash.batterySoC) / 100 * getBatteryCapacityKwh()) / Math.max(0.01, Math.min(dash.solar - dash.demand, getBatteryMaxRateKw())) * 100) / 100
        : null,
      tariffPeriod: dash.gridPrice === cfg.tariff.peakRatePerKwh ? 'peak' : (dash.gridPrice === cfg.tariff.offPeakRatePerKwh ? 'off-peak' : 'normal'),
      peakWindow: `${cfg.tariff.peakStartHour}:00-${cfg.tariff.peakEndHour}:00`,
    },
    // The real heuristic forecast from engine/forecast.js.
    forecastNext6Hours: forecast.points.slice(0, 6),
    forecastEngineLabel: forecast.engine,
    flexibleLoads: state.loads.map((l) => ({
      id: l.id,
      name: l.name,
      powerKw: l.power,
      durationHours: l.duration,
      priority: l.priority,
      critical: l.critical,
      baselineStartHour: l.baselineStart,
      scheduledStartHour: l.scheduledStart,
      forcedStatus: l.forcedStatus,
    })),
    recentAlerts: state.alerts.slice(0, 5).map((a) => ({
      severity: a.severity,
      time: a.time,
      source: a.source,
      description: a.description,
    })),
    tariff: cfg.tariff,
    // Stored, user-editable preferences (engine/memory.js). Null when the user
    // has set none. Never contains credentials — the memory store rejects them.
    userPreferences: memory.forContext(),
  };
}

module.exports = { buildEnergyContext };
