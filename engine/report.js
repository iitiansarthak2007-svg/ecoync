// engine/report.js
// EcoSync report generator.
//
// Assembles a structured report entirely from the deterministic engines
// (analytics, anomaly, scheduler, insightEngine). The AI layer may add a
// plain-English executive summary on top, but every figure in the report
// exists here first — so a report is still complete and accurate with no AI
// provider configured at all.
//
// Each section carries its own `basis` ('observed' | 'projection' | 'modelled')
// so a reader always knows which numbers were measured and which were modelled.

const analytics = require('./analytics');
const anomaly = require('./anomaly');
const scheduler = require('./scheduler');
const forecastEngine = require('./forecast');
const insightEngine = require('./insightEngine');
const settingsModule = require('./settings');
const memory = require('./memory');
const { state, hourFloat, currentSnapshot } = require('./state');

const PERIODS = {
  daily: { days: 1, label: 'Daily report' },
  weekly: { days: 7, label: 'Weekly report' },
  monthly: { days: 30, label: 'Monthly report' },
};

function generate(periodKey = 'daily', options = {}) {
  const key = String(periodKey).toLowerCase();
  const custom = key === 'custom';
  const spec = custom
    ? { days: Math.max(1, Math.min(365, Number(options.days) || 1)), label: `Custom report (${Math.max(1, Math.round(Number(options.days) || 1))} days)` }
    : PERIODS[key];

  if (!spec) {
    return { available: false, reason: `Unknown report period "${periodKey}". Use daily, weekly, monthly or custom.` };
  }

  const cfg = settingsModule.getSettings();
  const snap = currentSnapshot();
  const observed = analytics.observedWindow(null);
  const projection = spec.days === 1 ? analytics.projectDay() : analytics.projectPeriod(spec.days);
  const appliances = analytics.applianceBreakdown();
  const cost = analytics.costAnalysis();
  const score = analytics.energyScore();
  const findings = anomaly.detect();
  const baseLoad = analytics.estimateBaseLoad();
  const prefs = memory.getAll();

  // Scheduling opportunity, computed from the same optimizer the UI uses.
  const fc = forecastEngine.forecastNext24(hourFloat(), state.history);
  const sched = scheduler.optimizeSchedule(state.loads, fc.points, snap.gridPrice);

  const opportunities = [];
  if (sched.totals.costSaved > 0.5) {
    opportunities.push({
      title: 'Re-schedule flexible loads',
      detail: `The optimizer found start times capturing ${sched.totals.renewableUsed} kWh of forecast solar, avoiding ${sched.totals.gridAvoided} kWh of grid import.`,
      estimatedValue: `\u20b9${sched.totals.costSaved} per day`,
      basis: 'projection',
    });
  }
  if (baseLoad.baseLoadSharePct > 25) {
    opportunities.push({
      title: 'Reduce always-on base load',
      detail: `Base load is ${baseLoad.baseLoadKw} kW (${baseLoad.baseLoadSharePct}% of daily energy, ${baseLoad.baseLoadKwhPerDay} kWh/day).`,
      estimatedValue: `Each 0.1 kW removed saves roughly \u20b9${analytics.r2(0.1 * 24 * cfg.tariff.normalRatePerKwh)} per day`,
      basis: 'modelled',
    });
  }
  const peakLoads = appliances.appliances.filter((a) => a.runsInPeak && !a.critical);
  if (peakLoads.length) {
    opportunities.push({
      title: 'Move loads out of the peak window',
      detail: `${peakLoads.map((a) => a.name).join(', ')} run inside ${cfg.tariff.peakStartHour}:00\u2013${cfg.tariff.peakEndHour}:00 at \u20b9${cfg.tariff.peakRatePerKwh}/kWh.`,
      estimatedValue: `Up to \u20b9${analytics.r2(peakLoads.reduce((s, a) => s + a.estimatedCostRupeesPerDay, 0))} per day is exposed to peak pricing`,
      basis: 'modelled',
    });
  }

  const budget = prefs.monthlyBudgetRupees;
  const budgetSection = budget
    ? {
        budgetRupees: budget,
        projectedMonthlyRupees: snap.estimatedMonthlyCost,
        onTrack: snap.estimatedMonthlyCost <= budget,
        varianceRupees: analytics.r2(snap.estimatedMonthlyCost - budget),
        note: snap.estimatedMonthlyCost <= budget
          ? 'Projected spend is within your stated budget.'
          : 'Projected spend is above your stated budget \u2014 see the savings opportunities below.',
      }
    : null;

  return {
    available: true,
    period: custom ? 'custom' : key,
    title: spec.label,
    days: spec.days,
    generatedAt: new Date().toISOString(),
    clock: snap.hourLabel,
    dataSource: snap.dataSource,
    isSimulatedOrDemoData: /SIMULATION|MANUAL|DEMO/i.test(snap.dataSource),

    dataCoverage: {
      observedReadings: observed.available ? observed.readings : 0,
      observedSpanHours: observed.available ? observed.spanHoursSimulated : 0,
      note: spec.days > 1
        ? `EcoSync retains a rolling history of the current simulated day only. Totals for a ${spec.days}-day period are modelled projections, clearly marked as such.`
        : 'Observed sections come from recorded readings; projected sections are modelled across a full 24-hour day.',
    },

    energy: {
      basis: projection.basis,
      basisNote: projection.basisNote,
      totalDemandKwh: projection.demandKwh,
      solarGeneratedKwh: projection.solarGeneratedKwh,
      gridImportKwh: projection.gridImportKwh,
      renewableUtilizationPct: projection.renewableUtilizationPct,
      peakDemandKw: projection.peakDemandKw,
      peakDemandAt: projection.peakDemandHourLabel || (spec.days > 1 ? projection.perDay.peakDemandHourLabel : null),
      observedSoFar: observed.available
        ? { demandKwh: observed.demandKwh, solarKwh: observed.solarKwh, gridImportKwh: observed.gridImportKwh, peakDemandKw: observed.peakDemandKw, peakDemandAt: observed.peakDemandAt, window: `${observed.fromLabel}\u2013${observed.toLabel}` }
        : { unavailable: observed.reason },
    },

    cost: {
      basis: 'mixed',
      projectedRupees: projection.costRupees,
      projectedNetRupees: projection.netCostRupees,
      observedSoFarRupees: snap.energyCostSoFar,
      estimatedMonthlyRupees: snap.estimatedMonthlyCost,
      savingsVsBaselineRupees: snap.potentialSavingsSoFar,
      byTariffPeriod: spec.days === 1 ? projection.costByTariffPeriodRupees : projection.perDay.costByTariffPeriodRupees,
      tariff: cfg.tariff,
      budget: budgetSection,
    },

    appliances: {
      basis: appliances.basis,
      basisNote: appliances.basisNote,
      items: appliances.appliances.map((a) => ({
        name: a.name, energyKwhPerDay: a.energyKwhPerDay,
        costPerDayRupees: a.estimatedCostRupeesPerDay,
        costPerPeriodRupees: analytics.r2(a.estimatedCostRupeesPerDay * spec.days),
        sharePct: a.shareOfDailyEnergyPct, solarCoveragePct: a.solarCoveragePct,
        runsInPeak: a.runsInPeak, critical: a.critical, startLabel: a.startLabel,
      })),
      largestConsumer: appliances.largestConsumer,
      mostExpensive: appliances.mostExpensive,
      baseLoad: { kw: baseLoad.baseLoadKw, kwhPerDay: baseLoad.baseLoadKwhPerDay, sharePct: baseLoad.baseLoadSharePct },
    },

    solar: {
      basis: 'projection',
      generatedKwh: projection.solarGeneratedKwh,
      selfConsumedKwh: spec.days === 1 ? projection.solarToLoadKwh : analytics.r2(projection.perDay.solarToLoadKwh * spec.days),
      exportedKwh: projection.gridExportKwh !== undefined ? projection.gridExportKwh : null,
      exportRatePerKwh: cfg.tariff.solarExportRatePerKwh,
    },

    battery: {
      basis: 'mixed',
      currentSocPct: snap.batterySoC,
      capacityKwh: cfg.battery.capacityKwh,
      minReservePct: cfg.battery.minReservePct,
      maxRateKw: cfg.battery.maxRateKw,
      projectedEnergyServedKwh: spec.days === 1 ? projection.batteryToLoadKwh : analytics.r2(projection.perDay.batteryToLoadKwh * spec.days),
      observedSocRange: observed.available ? { startPct: observed.batteryStartPct, endPct: observed.batteryEndPct } : null,
    },

    anomalies: findings.available
      ? { count: findings.anomalies.length, summary: findings.summary, items: findings.anomalies }
      : { count: 0, summary: findings.reason, items: [] },

    energyScore: { score: score.score, grade: score.grade, confidence: score.confidence, confidenceReason: score.confidenceReason, components: score.components, weakest: score.weakest.label },

    savingsOpportunities: opportunities,

    recommendations: insightEngine.buildRecommendations(require('./aiContext').buildEnergyContext()),

    preferencesApplied: Object.keys(prefs).length ? prefs : null,

    disclaimer: /SIMULATION|MANUAL|DEMO/i.test(snap.dataSource)
      ? 'This report was generated from EcoSync\u2019s built-in simulation, not from metered hardware. Figures are illustrative of the modelled campus.'
      : 'Generated from the configured live energy API where available; projected sections remain modelled.',
  };
}

module.exports = { generate, PERIODS };
