// engine/anomaly.js
// EcoSync AI anomaly detection.
//
// This EXTENDS rather than replaces the lightweight inline detector in
// state.js (which raises live operational alerts as the simulation ticks).
// That one fires in real time on a single reading; this one looks across the
// whole recorded history window and produces a fully structured finding:
// severity, time, affected category, expected vs actual, difference, a
// plausible explanation, a recommended action, and a confidence rating.
//
// Everything here is deterministic. The AI layer explains these findings; it
// never generates them, so an anomaly can always be traced to real numbers.

const { solarProfile, demandProfile } = require('./profiles');
const settingsModule = require('./settings');
const { state, hourFloat } = require('./state');
const analytics = require('./analytics');

const r2 = analytics.r2;
const r1 = analytics.r1;
const r0 = analytics.r0;

// Confidence is a function of how much evidence supports the finding:
// more readings and a larger relative deviation => higher confidence.
function confidenceFrom(readings, relativeDeviation) {
  const evidence = Math.min(1, readings / 25);
  const strength = Math.min(1, Math.abs(relativeDeviation) / 0.6);
  const score = 0.35 + evidence * 0.3 + strength * 0.35;
  const value = Math.min(0.95, Math.round(score * 100) / 100);
  return {
    value,
    label: value >= 0.75 ? 'high' : value >= 0.55 ? 'medium' : 'low',
    reason: readings < 8
      ? `Only ${readings} readings support this, so confidence is limited.`
      : `Supported by ${readings} readings with a ${Math.round(Math.abs(relativeDeviation) * 100)}% deviation from the expected profile.`,
  };
}

function finding(o) {
  return {
    id: o.id,
    severity: o.severity,                 // 'attention' | 'warning' | 'info'
    category: o.category,                 // 'demand' | 'solar' | 'battery' | 'grid' | 'standby' | 'cost'
    affected: o.affected,                 // device / appliance / subsystem
    time: o.time,
    title: o.title,
    expected: o.expected,
    actual: o.actual,
    difference: o.difference,
    unit: o.unit,
    explanation: o.explanation,
    recommendedAction: o.recommendedAction,
    confidence: o.confidence,
    basis: o.basis || 'observed',
  };
}

function detect() {
  const cfg = settingsModule.getSettings();
  const scale = cfg.buildingProfileScale || 1;
  const hist = state.history;
  const nowLabel = require('./state').clockLabel();
  const out = [];

  if (hist.length < 4) {
    return {
      available: false,
      reason: `EcoSync has only ${hist.length} recorded reading(s). Anomaly detection needs a few more before it can compare against the expected profile.`,
      anomalies: [],
    };
  }

  // ---- 1. Sustained demand above the expected profile -------------------
  const deviations = hist.map((p) => {
    const expected = demandProfile(p.hour) * scale + analytics.flexiblePowerAt(p.hour, false, state.loads);
    return { p, expected, delta: p.demand - expected, rel: expected > 0 ? (p.demand - expected) / expected : 0 };
  });
  const recent = deviations.slice(-12);
  const avgRel = recent.reduce((s, d) => s + d.rel, 0) / recent.length;
  if (avgRel > 0.22) {
    const avgExpected = recent.reduce((s, d) => s + d.expected, 0) / recent.length;
    const avgActual = recent.reduce((s, d) => s + d.p.demand, 0) / recent.length;
    out.push(finding({
      id: 'demand_above_baseline',
      severity: avgRel > 0.45 ? 'attention' : 'warning',
      category: 'demand',
      affected: 'Main Energy Meter',
      time: `${recent[0].p.hourLabel}\u2013${recent[recent.length - 1].p.hourLabel}`,
      title: `Demand is running ${r0(avgRel * 100)}% above the expected profile`,
      expected: r2(avgExpected),
      actual: r2(avgActual),
      difference: r2(avgActual - avgExpected),
      unit: 'kW',
      explanation: `Across the last ${recent.length} readings, average demand was ${r2(avgActual)} kW against an expected ${r2(avgExpected)} kW for these hours. A sustained gap like this usually means an unscheduled high-draw load is running, or a flexible load is on outside its assigned window.`,
      recommendedAction: 'Check the Smart Loads panel for any load forced ON, then look for equipment running outside its normal schedule.',
      confidence: confidenceFrom(recent.length, avgRel),
    }));
  }

  // ---- 2. Individual demand spikes --------------------------------------
  const spikes = deviations.filter((d) => d.rel > 0.8 && d.delta > 1);
  if (spikes.length) {
    const worst = spikes.reduce((a, b) => (b.delta > a.delta ? b : a));
    out.push(finding({
      id: 'demand_spike',
      severity: 'warning',
      category: 'demand',
      affected: 'Main Energy Meter',
      time: worst.p.hourLabel,
      title: `Demand spike at ${worst.p.hourLabel}`,
      expected: r2(worst.expected),
      actual: r2(worst.p.demand),
      difference: r2(worst.delta),
      unit: 'kW',
      explanation: `A single reading reached ${r2(worst.p.demand)} kW where ${r2(worst.expected)} kW was expected \u2014 ${r0(worst.rel * 100)}% above profile. ${spikes.length > 1 ? `${spikes.length} such spikes were recorded in the current window.` : 'This was an isolated spike.'}`,
      recommendedAction: 'Correlate the timestamp with appliance start times; a simultaneous start of two high-power loads is the most common cause.',
      confidence: confidenceFrom(spikes.length, worst.rel),
    }));
  }

  // ---- 3. Solar underperformance during daylight ------------------------
  const daylight = hist.filter((p) => p.hour > 7 && p.hour < 17);
  if (daylight.length >= 4) {
    const expSum = daylight.reduce((s, p) => s + solarProfile(p.hour), 0);
    const actSum = daylight.reduce((s, p) => s + p.solar, 0);
    const rel = expSum > 0 ? (actSum - expSum) / expSum : 0;
    if (rel < -0.25) {
      out.push(finding({
        id: 'solar_underperformance',
        severity: rel < -0.5 ? 'attention' : 'warning',
        category: 'solar',
        affected: 'Solar Meter / Rooftop Array',
        time: `${daylight[0].hourLabel}\u2013${daylight[daylight.length - 1].hourLabel}`,
        title: `Solar output is ${r0(Math.abs(rel) * 100)}% below the expected curve`,
        expected: r2(expSum / daylight.length),
        actual: r2(actSum / daylight.length),
        difference: r2((actSum - expSum) / daylight.length),
        unit: 'kW (average across daylight readings)',
        explanation: `Average daylight generation was ${r2(actSum / daylight.length)} kW against an expected ${r2(expSum / daylight.length)} kW. Persistent shortfalls of this size point to shading, soiling, or an inverter limiting output \u2014 cloud cover produces a more irregular pattern.`,
        recommendedAction: 'Inspect the array for shading or soiling and check the inverter for fault or curtailment flags.',
        confidence: confidenceFrom(daylight.length, rel),
      }));
    }
  }

  // ---- 4. Overnight / standby waste -------------------------------------
  const night = hist.filter((p) => p.hour < 5 || p.hour >= 23);
  const baseLoad = analytics.estimateBaseLoad();
  if (night.length >= 3) {
    const avgNight = night.reduce((s, p) => s + p.demand, 0) / night.length;
    const rel = baseLoad.baseLoadKw > 0 ? (avgNight - baseLoad.baseLoadKw) / baseLoad.baseLoadKw : 0;
    if (rel > 0.3) {
      out.push(finding({
        id: 'overnight_waste',
        severity: 'warning',
        category: 'standby',
        affected: 'Base load / always-on equipment',
        time: `${night[0].hourLabel}\u2013${night[night.length - 1].hourLabel}`,
        title: 'Overnight consumption is above the expected base load',
        expected: r2(baseLoad.baseLoadKw),
        actual: r2(avgNight),
        difference: r2(avgNight - baseLoad.baseLoadKw),
        unit: 'kW',
        explanation: `Overnight demand averaged ${r2(avgNight)} kW where the modelled base load is ${r2(baseLoad.baseLoadKw)} kW. Overnight hours have no occupancy-driven demand, so the excess is equipment left running rather than genuine load.`,
        recommendedAction: `Audit always-on equipment. Eliminating the excess would save roughly ${r2((avgNight - baseLoad.baseLoadKw) * 6)} kWh per night.`,
        confidence: confidenceFrom(night.length, rel),
      }));
    }
  }
  if (baseLoad.baseLoadSharePct > 28) {
    out.push(finding({
      id: 'high_standby_share',
      severity: 'info',
      category: 'standby',
      affected: 'Building base load',
      time: nowLabel,
      title: `Base load is ${baseLoad.baseLoadSharePct}% of daily energy`,
      expected: 20,
      actual: baseLoad.baseLoadSharePct,
      difference: r1(baseLoad.baseLoadSharePct - 20),
      unit: '% of daily energy',
      explanation: `${baseLoad.baseLoadKw} kW runs continuously, which is ${baseLoad.baseLoadKwhPerDay} kWh/day before anyone switches anything on. Above roughly 20% of daily energy, base load is usually dominated by standby rather than essential equipment.`,
      recommendedAction: 'Identify continuously-powered equipment that could be switched off or put on a timer outside operating hours.',
      confidence: { value: 0.6, label: 'medium', reason: 'Derived from the building demand profile rather than per-circuit metering.' },
      basis: 'modelled',
    }));
  }

  // ---- 5. Battery anomalies ---------------------------------------------
  if (hist.length >= 5) {
    const recentB = hist.slice(-5);
    const drop = recentB[0].battery - recentB[recentB.length - 1].battery;
    const minReserve = require('./state').getBatteryMinReservePct();
    if (drop > 18) {
      out.push(finding({
        id: 'battery_rapid_discharge',
        severity: 'warning',
        category: 'battery',
        affected: 'Battery Sensor / Battery Room',
        time: `${recentB[0].hourLabel}\u2013${recentB[recentB.length - 1].hourLabel}`,
        title: `Battery dropped ${r0(drop)}% across the last ${recentB.length} readings`,
        expected: 'gradual discharge',
        actual: `${r0(drop)}% drop`,
        difference: r0(drop),
        unit: '% state of charge',
        explanation: `State of charge fell from ${r1(recentB[0].battery)}% to ${r1(recentB[recentB.length - 1].battery)}%. A drop this fast means discharge is running at or near the configured maximum rate to cover a demand deficit.`,
        recommendedAction: 'Confirm the discharge rate is within the configured maximum and that demand justifies it; consider shifting a flexible load.',
        confidence: confidenceFrom(recentB.length, drop / 100),
      }));
    }
    const last = hist[hist.length - 1];
    if (last.battery <= minReserve + 2) {
      out.push(finding({
        id: 'battery_at_reserve',
        severity: last.battery <= minReserve ? 'attention' : 'warning',
        category: 'battery',
        affected: 'Battery',
        time: last.hourLabel,
        title: 'Battery is at or near its minimum reserve',
        expected: `above ${minReserve}%`,
        actual: `${r1(last.battery)}%`,
        difference: r1(last.battery - minReserve),
        unit: '% state of charge',
        explanation: `The battery cannot discharge below its ${minReserve}% reserve, so it can no longer offset demand. Any remaining deficit goes to the grid.`,
        recommendedAction: 'Expect grid import until solar recovers. Avoid starting flexible loads until state of charge rebuilds.',
        confidence: { value: 0.9, label: 'high', reason: 'Read directly from the current battery state.' },
      }));
    }
  }

  // ---- 6. Grid import while solar is in surplus --------------------------
  const contradictory = hist.slice(-10).filter((p) => p.gridImport > 0.2 && p.solar > p.demand);
  if (contradictory.length >= 2) {
    const w = contradictory[contradictory.length - 1];
    out.push(finding({
      id: 'grid_import_during_surplus',
      severity: 'attention',
      category: 'grid',
      affected: 'Main Energy Meter / charge controller',
      time: w.hourLabel,
      title: 'Importing from the grid while solar exceeds demand',
      expected: 0,
      actual: r2(w.gridImport),
      difference: r2(w.gridImport),
      unit: 'kW grid import',
      explanation: `At ${w.hourLabel}, solar was ${r2(w.solar)} kW against ${r2(w.demand)} kW of demand, yet ${r2(w.gridImport)} kW was still imported. Generation should have covered the load entirely, so this points to a routing or availability fault rather than a shortfall.`,
      recommendedAction: 'Check battery availability flags and the charge controller — this pattern usually means generation is not being routed to the load.',
      confidence: confidenceFrom(contradictory.length, 1),
    }));
  }

  // ---- 7. Peak-window cost exposure -------------------------------------
  const apps = analytics.applianceBreakdown();
  const peakOffenders = apps.appliances.filter((a) => a.runsInPeak && !a.critical);
  if (peakOffenders.length) {
    const worst = peakOffenders[0];
    out.push(finding({
      id: 'peak_tariff_exposure',
      severity: 'info',
      category: 'cost',
      affected: worst.name,
      time: worst.startLabel,
      title: `${worst.name} runs inside the peak tariff window`,
      expected: `\u20b9${cfg.tariff.normalRatePerKwh}/kWh (normal rate)`,
      actual: `\u20b9${cfg.tariff.peakRatePerKwh}/kWh (peak rate)`,
      difference: r2(cfg.tariff.peakRatePerKwh - cfg.tariff.normalRatePerKwh),
      unit: '\u20b9/kWh',
      explanation: `${worst.name} (${worst.powerKw} kW for ${worst.durationHours}h) starts at ${worst.startLabel} and spends ${worst.hoursInPeakTariff}h in the ${cfg.tariff.peakStartHour}:00\u2013${cfg.tariff.peakEndHour}:00 peak window. It is not marked critical, so its start time can move.`,
      recommendedAction: 'Run the Smart Load optimizer to move it into a higher-solar, lower-tariff window.',
      confidence: { value: 0.8, label: 'high', reason: 'Computed directly from the configured schedule and tariff.' },
      basis: 'modelled',
    }));
  }

  const order = { attention: 0, warning: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity] || b.confidence.value - a.confidence.value);

  return {
    available: true,
    generatedAt: nowLabel,
    readingsAnalyzed: hist.length,
    anomalies: out,
    summary: out.length
      ? `${out.length} finding(s): ${out.filter((a) => a.severity === 'attention').length} needing attention, ${out.filter((a) => a.severity === 'warning').length} warning(s), ${out.filter((a) => a.severity === 'info').length} informational.`
      : 'No anomalies detected — all monitored signals are tracking their expected profiles.',
  };
}

module.exports = { detect };
