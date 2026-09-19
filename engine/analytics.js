// engine/analytics.js
// EcoSync Energy Analyst — the deterministic numeric core.
//
// WHY THIS EXISTS: an LLM must never be asked to compute a total, a
// percentage, a cost or a comparison (see STEP 23). Every number the AI layer
// quotes is produced here, by plain arithmetic over the real application
// state, and handed to the model as grounding. The model's job is to explain
// these numbers, never to produce them.
//
// DATA HONESTY — read this before adding a function:
//   * OBSERVED   — state.history is a rolling window (max 180 points) of
//                  actual simulated/live readings. Real, but short.
//   * MODELLED   — engine/profiles.js + state.loads describe the campus.
//                  Integrating them gives a full-day figure that is a
//                  PROJECTION, not a measurement.
//   * UNAVAILABLE— multi-day actuals, per-appliance metering, and weather.
//                  EcoSync does not retain or collect these. Functions that
//                  would need them return { available:false, reason } so the
//                  AI layer can say "I don't have that" instead of guessing.
// Every figure below is tagged with a `basis` so the UI and the AI can state
// where it came from.

const { solarProfile, demandProfile } = require('./profiles');
const settingsModule = require('./settings');
const { state, hourFloat, getBatteryCapacityKwh, getBatteryMinReservePct } = require('./state');

const STEP_H = 0.25; // 15-minute integration step over a simulated day

function r2(n) { return Math.round(Number(n) * 100) / 100; }
function r1(n) { return Math.round(Number(n) * 10) / 10; }
function r0(n) { return Math.round(Number(n)); }

// ---------------------------------------------------------------------------
// Load model helpers — a load is "on" for `duration` hours from its start
// hour. This mirrors activeLoadPowerAt() in state.js exactly, so analytics and
// the live simulation never disagree about when an appliance runs.
// ---------------------------------------------------------------------------
function loadStartHour(load, useScheduled) {
  return useScheduled && load.scheduledStart != null ? load.scheduledStart : load.baselineStart;
}

function loadIsOnAt(load, hour, useScheduled) {
  if (load.forcedStatus === 'off') return false;
  if (load.forcedStatus === 'on') return true;
  const start = loadStartHour(load, useScheduled);
  const h = ((hour - start) + 24) % 24;
  return h < load.duration;
}

function flexiblePowerAt(hour, useScheduled, loads) {
  let total = 0;
  for (const l of loads) if (loadIsOnAt(l, hour, useScheduled)) total += l.power;
  return total;
}

// ---------------------------------------------------------------------------
// Whole-day projection: integrates the profile + load model across 24 hours.
// This is the basis for daily/weekly/monthly figures — clearly a PROJECTION.
// ---------------------------------------------------------------------------
function projectDay(options = {}) {
  const cfg = settingsModule.getSettings();
  const loads = options.loads || state.loads;
  const scale = options.demandScale != null ? options.demandScale : (cfg.buildingProfileScale || 1);
  const solarScale = options.solarScale != null ? options.solarScale : 1;
  const useScheduled = options.useScheduled !== false;
  const tariffOverride = options.tariffMultiplier || 1;

  const batteryEnabled = options.batteryEnabled !== false;
  const batteryCapacity = options.batteryCapacityKwh != null ? options.batteryCapacityKwh : getBatteryCapacityKwh();
  const minReserve = getBatteryMinReservePct();
  const maxRate = cfg.battery.maxRateKw;

  // Battery is walked through the day so solar stored in the morning can be
  // credited against evening demand — the same physics the live tick uses.
  let soc = 55;
  const byHour = [];
  const totals = {
    demandKwh: 0, solarKwh: 0, solarToLoadKwh: 0, batteryToLoadKwh: 0,
    gridImportKwh: 0, gridExportKwh: 0, costRupees: 0, exportCreditRupees: 0,
    peakDemandKw: 0, peakDemandHour: null,
  };
  const energyByPeriod = { peak: 0, normal: 0, offPeak: 0 };
  const costByPeriodR = { peak: 0, normal: 0, offPeak: 0 };

  for (let h = 0; h < 24; h += STEP_H) {
    const solar = solarProfile(h) * solarScale;
    const baseDemand = demandProfile(h) * scale;
    const flex = flexiblePowerAt(h, useScheduled, loads);
    const demand = baseDemand + flex;
    const rate = settingsModule.tariffRateAt(h, cfg) * tariffOverride;
    const period = tariffPeriodAt(h, cfg);

    const solarToLoad = Math.min(solar, demand);
    let net = solar - demand;
    let battToLoad = 0;
    let gridImport = 0;
    let gridExport = 0;

    if (net >= 0) {
      if (batteryEnabled && soc < 99 && batteryCapacity > 0) {
        const roomKwh = ((100 - soc) / 100) * batteryCapacity;
        const chargeKw = Math.min(net, maxRate, roomKwh / STEP_H);
        soc += (chargeKw * STEP_H * 100) / batteryCapacity;
        gridExport = Math.max(0, net - chargeKw);
      } else {
        gridExport = net;
      }
    } else {
      const deficit = -net;
      if (batteryEnabled && soc > minReserve && batteryCapacity > 0) {
        const availKwh = ((soc - minReserve) / 100) * batteryCapacity;
        const dischargeKw = Math.min(deficit, maxRate, availKwh / STEP_H);
        battToLoad = dischargeKw;
        soc -= (dischargeKw * STEP_H * 100) / batteryCapacity;
        gridImport = Math.max(0, deficit - dischargeKw);
      } else {
        gridImport = deficit;
      }
    }
    soc = Math.max(0, Math.min(100, soc));

    totals.demandKwh += demand * STEP_H;
    totals.solarKwh += solar * STEP_H;
    totals.solarToLoadKwh += solarToLoad * STEP_H;
    totals.batteryToLoadKwh += battToLoad * STEP_H;
    totals.gridImportKwh += gridImport * STEP_H;
    totals.gridExportKwh += gridExport * STEP_H;
    totals.costRupees += gridImport * STEP_H * rate;
    totals.exportCreditRupees += gridExport * STEP_H * cfg.tariff.solarExportRatePerKwh;
    energyByPeriod[period] += demand * STEP_H;
    costByPeriodR[period] += gridImport * STEP_H * rate;

    if (demand > totals.peakDemandKw) {
      totals.peakDemandKw = demand;
      totals.peakDemandHour = h;
    }
    if (Math.abs(h % 1) < 1e-9) {
      byHour.push({
        hour: h,
        hourLabel: `${String(h).padStart(2, '0')}:00`,
        solarKw: r2(solar), demandKw: r2(demand),
        gridImportKw: r2(gridImport), batterySocPct: r0(soc), ratePerKwh: r2(rate),
      });
    }
  }

  const renewablePct = totals.demandKwh > 0
    ? ((totals.solarToLoadKwh + totals.batteryToLoadKwh) / totals.demandKwh) * 100 : 0;

  return {
    basis: 'projection',
    basisNote: 'Integrated from EcoSync\u2019s deterministic load and solar profiles across a full 24-hour day at the current settings. This is a modelled projection, not a metered measurement.',
    demandKwh: r2(totals.demandKwh),
    solarGeneratedKwh: r2(totals.solarKwh),
    solarToLoadKwh: r2(totals.solarToLoadKwh),
    batteryToLoadKwh: r2(totals.batteryToLoadKwh),
    gridImportKwh: r2(totals.gridImportKwh),
    gridExportKwh: r2(totals.gridExportKwh),
    costRupees: r2(totals.costRupees),
    exportCreditRupees: r2(totals.exportCreditRupees),
    netCostRupees: r2(totals.costRupees - totals.exportCreditRupees),
    peakDemandKw: r2(totals.peakDemandKw),
    peakDemandHourLabel: totals.peakDemandHour != null
      ? `${String(Math.floor(totals.peakDemandHour)).padStart(2, '0')}:${String(Math.round((totals.peakDemandHour % 1) * 60)).padStart(2, '0')}`
      : null,
    renewableUtilizationPct: r1(renewablePct),
    energyByTariffPeriodKwh: { peak: r2(energyByPeriod.peak), normal: r2(energyByPeriod.normal), offPeak: r2(energyByPeriod.offPeak) },
    costByTariffPeriodRupees: { peak: r2(costByPeriodR.peak), normal: r2(costByPeriodR.normal), offPeak: r2(costByPeriodR.offPeak) },
    byHour,
  };
}

function tariffPeriodAt(hourFloatVal, cfg) {
  const t = (cfg || settingsModule.getSettings()).tariff;
  const h = ((hourFloatVal % 24) + 24) % 24;
  if (h >= t.peakStartHour && h < t.peakEndHour) return 'peak';
  if (h < 6 || h >= 22) return 'offPeak';
  return 'normal';
}

// ---------------------------------------------------------------------------
// OBSERVED data — integrates the actual rolling history window.
// ---------------------------------------------------------------------------
function observedWindow(hoursBack) {
  const hist = state.history;
  if (!hist.length) {
    return { available: false, reason: 'No readings have been recorded yet. EcoSync needs to run for a few moments first.' };
  }
  const nowH = hourFloat();
  const pts = hoursBack == null ? hist.slice() : hist.filter((p) => {
    const diff = ((nowH - p.hour) + 24) % 24;
    return diff <= hoursBack;
  });
  if (pts.length < 2) {
    return { available: false, reason: `Only ${pts.length} reading(s) fall inside that window — not enough to integrate.` };
  }

  // Trapezoidal integration over simulated hours between consecutive points.
  let demandKwh = 0, solarKwh = 0, gridKwh = 0, exportKwh = 0, peak = 0, peakAt = null;
  for (let i = 1; i < pts.length; i++) {
    let dh = pts[i].hour - pts[i - 1].hour;
    if (dh < 0) dh += 24;              // wrapped past midnight
    if (dh > 2) continue;              // gap (restart) — don't integrate across it
    demandKwh += ((pts[i].demand + pts[i - 1].demand) / 2) * dh;
    solarKwh += ((pts[i].solar + pts[i - 1].solar) / 2) * dh;
    gridKwh += ((pts[i].gridImport + pts[i - 1].gridImport) / 2) * dh;
    exportKwh += ((pts[i].gridExport + pts[i - 1].gridExport) / 2) * dh;
    if (pts[i].demand > peak) { peak = pts[i].demand; peakAt = pts[i].hourLabel; }
  }

  const demands = pts.map((p) => p.demand);
  const spanHours = pts.length > 1 ? (((pts[pts.length - 1].hour - pts[0].hour) + 24) % 24) : 0;

  return {
    available: true,
    basis: 'observed',
    basisNote: 'Integrated from EcoSync\u2019s actual recorded readings in its rolling history buffer.',
    readings: pts.length,
    spanHoursSimulated: r2(spanHours),
    fromLabel: pts[0].hourLabel,
    toLabel: pts[pts.length - 1].hourLabel,
    demandKwh: r2(demandKwh),
    solarKwh: r2(solarKwh),
    gridImportKwh: r2(gridKwh),
    gridExportKwh: r2(exportKwh),
    peakDemandKw: r2(peak),
    peakDemandAt: peakAt,
    avgDemandKw: r2(demands.reduce((a, b) => a + b, 0) / demands.length),
    minDemandKw: r2(Math.min(...demands)),
    maxDemandKw: r2(Math.max(...demands)),
    batteryStartPct: r1(pts[0].battery),
    batteryEndPct: r1(pts[pts.length - 1].battery),
  };
}

// ---------------------------------------------------------------------------
// Appliance analytics — derived from the real load model, not invented.
// EcoSync does not have per-appliance metering; these are the modelled
// consumption of each configured flexible load, which is stated plainly.
// ---------------------------------------------------------------------------
function applianceBreakdown() {
  const cfg = settingsModule.getSettings();
  const loads = state.loads;
  const day = projectDay();
  const baseLoadKwh = estimateBaseLoad().baseLoadKwhPerDay;

  const items = loads.map((l) => {
    const start = loadStartHour(l, true);
    const energyKwh = l.power * l.duration;

    // Cost and solar coverage across the hours this appliance actually runs.
    let cost = 0, solarCovered = 0, peakHours = 0;
    for (let h = start; h < start + l.duration; h += STEP_H) {
      const hm = ((h % 24) + 24) % 24;
      const rate = settingsModule.tariffRateAt(hm, cfg);
      const solar = solarProfile(hm);
      const baseDemand = demandProfile(hm) * (cfg.buildingProfileScale || 1);
      // Solar available to THIS appliance = whatever is left after base demand.
      const spare = Math.max(0, solar - baseDemand);
      const fromSolar = Math.min(l.power, spare);
      solarCovered += fromSolar * STEP_H;
      cost += (l.power - fromSolar) * STEP_H * rate;
      if (tariffPeriodAt(hm, cfg) === 'peak') peakHours += STEP_H;
    }

    return {
      id: l.id,
      name: l.name,
      powerKw: l.power,
      durationHours: l.duration,
      priority: l.priority,
      critical: l.critical,
      startHour: start,
      startLabel: `${String(start).padStart(2, '0')}:00`,
      usingScheduledStart: l.scheduledStart != null,
      forcedStatus: l.forcedStatus,
      energyKwhPerDay: r2(energyKwh),
      estimatedCostRupeesPerDay: r2(cost),
      estimatedCostRupeesPerMonth: r2(cost * 30),
      solarCoveredKwh: r2(solarCovered),
      solarCoveragePct: energyKwh > 0 ? r0((solarCovered / energyKwh) * 100) : 0,
      hoursInPeakTariff: r2(peakHours),
      runsInPeak: peakHours > 0,
    };
  });

  const flexTotalKwh = items.reduce((s, i) => s + i.energyKwhPerDay, 0);
  const totalKwh = flexTotalKwh + baseLoadKwh;
  items.forEach((i) => { i.shareOfDailyEnergyPct = totalKwh > 0 ? r1((i.energyKwhPerDay / totalKwh) * 100) : 0; });
  items.sort((a, b) => b.estimatedCostRupeesPerDay - a.estimatedCostRupeesPerDay);

  return {
    basis: 'modelled',
    basisNote: 'EcoSync has no per-appliance sub-metering. These figures are computed from each configured load\u2019s rated power, duration and scheduled start hour, priced against the current tariff.',
    appliances: items,
    baseLoadKwhPerDay: r2(baseLoadKwh),
    baseLoadNote: 'Everything that is not a configured flexible load (lighting, always-on equipment, etc.), taken from the building demand profile.',
    flexibleTotalKwhPerDay: r2(flexTotalKwh),
    totalDailyKwh: r2(totalKwh),
    largestConsumer: items.length ? items.reduce((a, b) => (b.energyKwhPerDay > a.energyKwhPerDay ? b : a)).name : null,
    mostExpensive: items.length ? items[0].name : null,
    projectedDayCostRupees: day.costRupees,
  };
}

// Standby / base load: the minimum of the demand profile across the whole day
// is, by definition, load that never switches off.
function estimateBaseLoad() {
  const cfg = settingsModule.getSettings();
  const scale = cfg.buildingProfileScale || 1;
  let min = Infinity, minHour = 0, total = 0, n = 0;
  let nightTotal = 0, nightN = 0;
  for (let h = 0; h < 24; h += STEP_H) {
    const d = demandProfile(h) * scale;
    if (d < min) { min = d; minHour = h; }
    total += d * STEP_H; n++;
    if (h < 5 || h >= 23) { nightTotal += d * STEP_H; nightN += STEP_H; }
  }
  const dayKwh = total;
  const standbyKwh = min * 24;
  return {
    basis: 'modelled',
    baseLoadKw: r2(min),
    baseLoadAtHour: `${String(Math.floor(minHour)).padStart(2, '0')}:00`,
    baseLoadKwhPerDay: r2(standbyKwh),
    totalProfileKwhPerDay: r2(dayKwh),
    baseLoadSharePct: dayKwh > 0 ? r1((standbyKwh / dayKwh) * 100) : 0,
    overnightKwh: r2(nightTotal),
    overnightHours: r2(nightN),
    note: 'Base load is the lowest sustained demand across the day — equipment that never switches off. A high share here usually means standby waste.',
  };
}

// ---------------------------------------------------------------------------
// Cost analysis
// ---------------------------------------------------------------------------
function costAnalysis() {
  const cfg = settingsModule.getSettings();
  const day = projectDay();
  const snap = require('./state').currentSnapshot();
  const apps = applianceBreakdown();

  const peakShare = day.demandKwh > 0 ? (day.energyByTariffPeriodKwh.peak / day.demandKwh) * 100 : 0;
  const appliancesInPeak = apps.appliances.filter((a) => a.runsInPeak && !a.critical);

  return {
    basis: 'mixed',
    tariff: cfg.tariff,
    currentRatePerKwh: snap.gridPrice,
    currentPeriod: tariffPeriodAt(hourFloat(), cfg),
    peakWindow: `${cfg.tariff.peakStartHour}:00-${cfg.tariff.peakEndHour}:00`,
    observedSoFar: {
      basis: 'observed',
      gridImportCostRupees: snap.energyCostSoFar,
      netCostRupees: snap.netCostSoFar,
      exportCreditRupees: snap.exportRevenueSoFar,
      savingsVsBaselineRupees: snap.potentialSavingsSoFar,
    },
    projectedFullDay: {
      basis: 'projection',
      gridImportCostRupees: day.costRupees,
      netCostRupees: day.netCostRupees,
      energyByPeriodKwh: day.energyByTariffPeriodKwh,
      costByPeriodRupees: day.costByTariffPeriodRupees,
      peakSharePct: r1(peakShare),
    },
    estimatedMonthlyCostRupees: snap.estimatedMonthlyCost,
    estimatedMonthlyNote: 'Extrapolated from the cost rate observed so far today. It is a projection, not a bill.',
    costReductionLevers: appliancesInPeak.map((a) => ({
      appliance: a.name,
      reason: `Runs ${a.hoursInPeakTariff}h inside the peak window (\u20b9${cfg.tariff.peakRatePerKwh}/kWh) and is not marked critical.`,
      estimatedCostRupeesPerDay: a.estimatedCostRupeesPerDay,
    })),
  };
}

// ---------------------------------------------------------------------------
// Explainable Energy Score — every component is a real measured/modelled
// ratio, with its own sub-score, weight and explanation. No random numbers.
// ---------------------------------------------------------------------------
function energyScore() {
  const snap = require('./state').currentSnapshot();
  const day = projectDay();
  const base = estimateBaseLoad();
  const apps = applianceBreakdown();
  const observed = observedWindow(null);

  const components = [];

  // 1. Renewable utilization (observed cumulative) — 30%
  const renew = snap.renewableUtilizationPct || 0;
  components.push({
    key: 'renewable_utilization',
    label: 'Renewable utilization',
    weight: 30,
    value: renew,
    valueLabel: `${r0(renew)}% of demand served by solar or stored solar`,
    score: Math.max(0, Math.min(100, renew)),
    basis: 'observed',
    explanation: `${r0(renew)}% of everything consumed so far was covered by on-site generation or the battery rather than the grid.`,
  });

  // 2. Peak-period avoidance — 25%
  const peakShare = day.demandKwh > 0 ? (day.energyByTariffPeriodKwh.peak / day.demandKwh) * 100 : 0;
  const peakScore = Math.max(0, 100 - peakShare * 2.5); // 40% of energy in peak => 0
  components.push({
    key: 'peak_avoidance',
    label: 'Peak-period avoidance',
    weight: 25,
    value: r1(peakShare),
    valueLabel: `${r1(peakShare)}% of daily energy falls in the peak window`,
    score: r0(peakScore),
    basis: 'projection',
    explanation: `Energy drawn inside the peak tariff window is charged at the highest rate, so a lower share is better. This projection puts ${r1(peakShare)}% of the day\u2019s energy inside that window.`,
  });

  // 3. Standby / base-load efficiency — 20%
  // The 25% threshold is an assumption, not a measurement: below roughly a
  // quarter of daily energy, a flat base load is normal for a campus. The
  // slope is deliberately gentle so this component still discriminates at
  // high base-load shares instead of saturating at zero and going silent.
  const standbyShare = base.baseLoadSharePct;
  const STANDBY_THRESHOLD_PCT = 25;
  const standbyScore = Math.max(0, 100 - Math.max(0, standbyShare - STANDBY_THRESHOLD_PCT) * 1.6);
  components.push({
    key: 'standby_efficiency',
    label: 'Standby / base-load efficiency',
    weight: 20,
    value: standbyShare,
    valueLabel: `${standbyShare}% of daily energy is always-on base load`,
    score: r0(standbyScore),
    basis: 'modelled',
    explanation: `Base load is ${base.baseLoadKw} kW running continuously (${base.baseLoadKwhPerDay} kWh/day), which is ${standbyShare}% of daily energy. This component scores against an assumed ${STANDBY_THRESHOLD_PCT}% threshold \u2014 above that, a flat always-on load usually indicates standby waste rather than essential equipment.`,
  });

  // 4. Scheduling efficiency — 15%
  const shiftable = apps.appliances.filter((a) => !a.critical);
  const scheduled = shiftable.filter((a) => a.usingScheduledStart).length;
  const solarCoverAvg = shiftable.length
    ? shiftable.reduce((s, a) => s + a.solarCoveragePct, 0) / shiftable.length : 0;
  components.push({
    key: 'scheduling_efficiency',
    label: 'Scheduling efficiency',
    weight: 15,
    value: r1(solarCoverAvg),
    valueLabel: `${r1(solarCoverAvg)}% average solar coverage across flexible loads`,
    score: r0(Math.min(100, solarCoverAvg * 1.4)),
    basis: 'modelled',
    explanation: `${scheduled} of ${shiftable.length} flexible loads are running on an optimizer-assigned start time. Their runs are currently covered ${r1(solarCoverAvg)}% by surplus solar.`,
  });

  // 5. Battery utilization — 10%
  const batteryUse = day.demandKwh > 0 ? (day.batteryToLoadKwh / day.demandKwh) * 100 : 0;
  components.push({
    key: 'battery_utilization',
    label: 'Battery utilization',
    weight: 10,
    value: r1(batteryUse),
    valueLabel: `${day.batteryToLoadKwh} kWh/day served from storage`,
    score: r0(Math.min(100, batteryUse * 6)),
    basis: 'projection',
    explanation: `The battery is projected to cover ${day.batteryToLoadKwh} kWh of demand per day (${r1(batteryUse)}% of the total), shifting solar into the evening instead of importing.`,
  });

  const total = components.reduce((s, c) => s + c.score * (c.weight / 100), 0);
  const grade = total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : total >= 40 ? 'D' : 'E';

  // Confidence reflects how much real history backs the observed components.
  const readings = observed.available ? observed.readings : 0;
  const confidence = readings >= 60 ? 'high' : readings >= 20 ? 'medium' : 'low';

  return {
    score: r0(total),
    grade,
    confidence,
    confidenceReason: readings >= 60
      ? `Based on ${readings} recorded readings plus the deterministic campus model.`
      : readings >= 20
      ? `Based on ${readings} recorded readings — the observed components will firm up as EcoSync runs longer.`
      : `Only ${readings} readings are available so far, so observed components carry little history. Modelled components are unaffected.`,
    components,
    weakest: components.slice().sort((a, b) => a.score - b.score)[0],
    strongest: components.slice().sort((a, b) => b.score - a.score)[0],
    methodology: 'Weighted mean of five measured or modelled ratios. No part of this score is generated by a language model.',
  };
}

// ---------------------------------------------------------------------------
// Period comparison. EcoSync keeps only a rolling window, so an honest
// comparison is "recent observed" vs "the expected profile for the same
// hours" — it explicitly refuses week-over-week requests it cannot support.
// ---------------------------------------------------------------------------
function comparePeriods(periodA = 'recent', periodB = 'expected') {
  const MULTI_DAY = ['yesterday', 'lastweek', 'last_week', 'week', 'lastmonth', 'last_month', 'month'];
  const wants = [String(periodA).toLowerCase(), String(periodB).toLowerCase()];
  const unsupported = wants.find((w) => MULTI_DAY.includes(w.replace(/\s+/g, '')));
  if (unsupported) {
    return {
      available: false,
      reason: `EcoSync keeps a rolling history buffer of the current simulated day only — it does not retain day-over-day or week-over-week actuals, so a "${unsupported}" comparison cannot be produced from real data.`,
      alternative: 'I can compare the readings recorded so far against the expected profile for those same hours, which shows whether the campus is running above or below its normal pattern.',
    };
  }

  const obs = observedWindow(null);
  if (!obs.available) return { available: false, reason: obs.reason };

  const cfg = settingsModule.getSettings();
  const scale = cfg.buildingProfileScale || 1;
  const pts = state.history;

  // Expected demand/solar for exactly the hours we actually observed.
  let expDemandKwh = 0, expSolarKwh = 0;
  for (let i = 1; i < pts.length; i++) {
    let dh = pts[i].hour - pts[i - 1].hour;
    if (dh < 0) dh += 24;
    if (dh > 2) continue;
    const mid = pts[i - 1].hour + dh / 2;
    expDemandKwh += (demandProfile(mid) * scale + flexiblePowerAt(mid, false, state.loads)) * dh;
    expSolarKwh += solarProfile(mid) * dh;
  }

  const demandDelta = obs.demandKwh - expDemandKwh;
  const solarDelta = obs.solarKwh - expSolarKwh;

  return {
    available: true,
    basis: 'observed vs modelled',
    windowLabel: `${obs.fromLabel} \u2192 ${obs.toLabel} (${obs.spanHoursSimulated} simulated hours, ${obs.readings} readings)`,
    demand: {
      observedKwh: obs.demandKwh,
      expectedKwh: r2(expDemandKwh),
      deltaKwh: r2(demandDelta),
      deltaPct: expDemandKwh > 0 ? r1((demandDelta / expDemandKwh) * 100) : null,
    },
    solar: {
      observedKwh: obs.solarKwh,
      expectedKwh: r2(expSolarKwh),
      deltaKwh: r2(solarDelta),
      deltaPct: expSolarKwh > 0 ? r1((solarDelta / expSolarKwh) * 100) : null,
    },
    peakDemandKw: obs.peakDemandKw,
    peakDemandAt: obs.peakDemandAt,
    verdict: Math.abs(demandDelta) < expDemandKwh * 0.05
      ? 'Consumption is tracking the expected profile closely.'
      : demandDelta > 0
      ? 'Consumption is running above the expected profile for these hours.'
      : 'Consumption is running below the expected profile for these hours.',
  };
}

// Weekly / monthly figures: projections from the day model, clearly labelled.
function projectPeriod(days) {
  const day = projectDay();
  const n = Math.max(1, Math.round(days));
  return {
    basis: 'projection',
    basisNote: `EcoSync does not retain ${n} days of measured history. These figures are the modelled daily total multiplied by ${n}, at the current settings, tariff and schedule. Treat them as a planning estimate, not a meter reading.`,
    days: n,
    demandKwh: r2(day.demandKwh * n),
    solarGeneratedKwh: r2(day.solarGeneratedKwh * n),
    gridImportKwh: r2(day.gridImportKwh * n),
    costRupees: r2(day.costRupees * n),
    netCostRupees: r2(day.netCostRupees * n),
    peakDemandKw: day.peakDemandKw,
    renewableUtilizationPct: day.renewableUtilizationPct,
    perDay: day,
  };
}

module.exports = {
  projectDay, projectPeriod, observedWindow, applianceBreakdown, estimateBaseLoad,
  costAnalysis, energyScore, comparePeriods, tariffPeriodAt,
  flexiblePowerAt, loadStartHour, loadIsOnAt, r2, r1, r0,
};
