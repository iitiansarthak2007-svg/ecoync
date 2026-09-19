// engine/whatif.js
// EcoSync What-If Simulator.
//
// Every scenario re-runs the SAME deterministic day model used everywhere
// else (analytics.projectDay), once for the current configuration and once
// with a single variable changed. The difference between the two runs is the
// answer — nothing is estimated by a language model, and every scenario
// returns the assumptions it relied on so the result can be audited.
//
// This is the engine behind both the "What if…" chat questions and the
// Scenario Simulator panel's AI comparisons. It does NOT mutate live state:
// it works on copies, so running a scenario never disturbs the simulation.

const analytics = require('./analytics');
const settingsModule = require('./settings');
const { state, getBatteryCapacityKwh } = require('./state');

const r2 = analytics.r2;
const r1 = analytics.r1;

function cloneLoads() {
  return state.loads.map((l) => ({ ...l }));
}

function diff(baseline, variant) {
  return {
    demandKwh: r2(variant.demandKwh - baseline.demandKwh),
    gridImportKwh: r2(variant.gridImportKwh - baseline.gridImportKwh),
    costRupees: r2(variant.costRupees - baseline.costRupees),
    netCostRupees: r2(variant.netCostRupees - baseline.netCostRupees),
    peakDemandKw: r2(variant.peakDemandKw - baseline.peakDemandKw),
    renewableUtilizationPct: r1(variant.renewableUtilizationPct - baseline.renewableUtilizationPct),
    savingsRupeesPerDay: r2(baseline.netCostRupees - variant.netCostRupees),
    savingsRupeesPerMonth: r2((baseline.netCostRupees - variant.netCostRupees) * 30),
  };
}

function result(name, description, baseline, variant, assumptions, explanation) {
  const d = diff(baseline, variant);
  return {
    available: true,
    scenario: name,
    description,
    current: baseline,
    alternative: variant,
    difference: d,
    headline: d.savingsRupeesPerDay > 0.01
      ? `Saves about \u20b9${d.savingsRupeesPerDay}/day (\u2248 \u20b9${d.savingsRupeesPerMonth}/month).`
      : d.savingsRupeesPerDay < -0.01
      ? `Costs about \u20b9${Math.abs(d.savingsRupeesPerDay)}/day more (\u2248 \u20b9${Math.abs(d.savingsRupeesPerMonth)}/month).`
      : 'No meaningful cost difference.',
    explanation,
    assumptions,
  };
}

const SHARED_ASSUMPTIONS = [
  'Both runs use EcoSync\u2019s deterministic 24-hour solar and demand profiles at the current settings.',
  'Only the one variable named in the scenario changes; everything else is held constant.',
  'Costs use the tariff currently configured on the Settings page.',
  'Figures are modelled projections for a representative day, not metered measurements.',
];

// --- 1. Reduce the runtime of an appliance --------------------------------
function reduceApplianceHours(loadId, hoursLess) {
  const target = state.loads.find((l) => l.id === loadId);
  if (!target) return { available: false, reason: `No load with id "${loadId}" exists. Available: ${state.loads.map((l) => l.id).join(', ')}.` };
  const cut = Math.max(0, Number(hoursLess) || 0);
  if (cut <= 0) return { available: false, reason: 'Specify how many hours less the appliance should run.' };

  const baseline = analytics.projectDay();
  const loads = cloneLoads();
  const v = loads.find((l) => l.id === loadId);
  const newDuration = Math.max(0, v.duration - cut);
  v.duration = newDuration;
  const variant = analytics.projectDay({ loads });

  return result(
    `Run ${target.name} for ${cut}h less`,
    `${target.name} currently runs ${target.duration}h/day at ${target.power} kW. This scenario runs it ${newDuration}h/day.`,
    baseline, variant,
    [...SHARED_ASSUMPTIONS, `Assumes the reduced runtime still meets the appliance\u2019s purpose \u2014 EcoSync cannot verify that.${target.critical ? ' NOTE: this load is marked CRITICAL, so reducing it may not be operationally acceptable.' : ''}`],
    `Cutting ${cut}h removes ${r2(target.power * cut)} kWh/day of demand. The saving is less than the full ${r2(target.power * cut)} kWh would suggest whenever the removed hours were already covered by surplus solar rather than the grid.`
  );
}

// --- 2. Shift an appliance to a different start hour ----------------------
function shiftAppliance(loadId, newStartHour) {
  const target = state.loads.find((l) => l.id === loadId);
  if (!target) return { available: false, reason: `No load with id "${loadId}" exists. Available: ${state.loads.map((l) => l.id).join(', ')}.` };
  const start = Math.max(0, Math.min(23, Math.round(Number(newStartHour))));
  if (!Number.isFinite(start)) return { available: false, reason: 'A valid start hour (0-23) is required.' };

  const baseline = analytics.projectDay();
  const loads = cloneLoads();
  const v = loads.find((l) => l.id === loadId);
  const currentStart = analytics.loadStartHour(target, true);
  v.scheduledStart = start;
  v.forcedStatus = null;
  const variant = analytics.projectDay({ loads });

  const cfg = settingsModule.getSettings();
  const outsideWindow = start < target.earliestStart || start + target.duration > target.latestFinish;

  return result(
    `Move ${target.name} to ${String(start).padStart(2, '0')}:00`,
    `${target.name} currently starts at ${String(currentStart).padStart(2, '0')}:00 and runs ${target.duration}h.`,
    baseline, variant,
    [
      ...SHARED_ASSUMPTIONS,
      `The appliance\u2019s allowed window is ${target.earliestStart}:00\u2013${target.latestFinish}:00.${outsideWindow ? ' WARNING: the requested start falls outside that window.' : ''}`,
      'Assumes the appliance can be deferred without operational impact.',
    ],
    `Moving the run changes how much of it is covered by surplus solar and which tariff band it falls in (peak is ${cfg.tariff.peakStartHour}:00\u2013${cfg.tariff.peakEndHour}:00 at \u20b9${cfg.tariff.peakRatePerKwh}/kWh). Total energy consumed is unchanged \u2014 only its source and price move.`
  );
}

// --- 3. Tariff change ------------------------------------------------------
function tariffChange(pctChange) {
  const pct = Number(pctChange);
  if (!Number.isFinite(pct)) return { available: false, reason: 'A percentage change is required, e.g. 10 for a 10% increase.' };
  const baseline = analytics.projectDay();
  const variant = analytics.projectDay({ tariffMultiplier: 1 + pct / 100 });
  return result(
    `Electricity prices ${pct >= 0 ? 'rise' : 'fall'} ${Math.abs(pct)}%`,
    `Applies a ${pct >= 0 ? '+' : ''}${pct}% change to every tariff band.`,
    baseline, variant,
    [...SHARED_ASSUMPTIONS, 'Assumes all bands (peak, normal, off-peak) move by the same percentage.', 'The solar export rate is held constant.'],
    `Consumption and grid import are unchanged \u2014 only the price of imported energy moves. This is why a strong solar and battery share insulates the site: the bill moves by less than the tariff does.`
  );
}

// --- 4. Add / change solar capacity ---------------------------------------
function changeSolar(multiplier) {
  const m = Number(multiplier);
  if (!Number.isFinite(m) || m < 0) return { available: false, reason: 'A solar capacity multiplier is required, e.g. 1.5 for 50% more array.' };
  const baseline = analytics.projectDay();
  const variant = analytics.projectDay({ solarScale: m });
  return result(
    `Solar capacity \u00d7${m}`,
    `Scales the modelled array output to ${m}\u00d7 its current size.`,
    baseline, variant,
    [...SHARED_ASSUMPTIONS, 'Assumes the new capacity has the same orientation and daily shape as the existing array.', 'Capital cost, roof area and inverter limits are NOT modelled \u2014 this shows the energy and running-cost effect only.'],
    `Extra generation first displaces grid import, then charges the battery, and only then exports at \u20b9${settingsModule.getSettings().tariff.solarExportRatePerKwh}/kWh. Because export pays far less than import costs, returns diminish once demand and storage are already covered.`
  );
}

// --- 5. Add / change battery capacity -------------------------------------
function changeBattery(capacityKwh) {
  const cap = Number(capacityKwh);
  if (!Number.isFinite(cap) || cap < 0) return { available: false, reason: 'A battery capacity in kWh is required.' };
  const baseline = analytics.projectDay();
  const variant = analytics.projectDay({ batteryCapacityKwh: cap, batteryEnabled: cap > 0 });
  const currentCap = getBatteryCapacityKwh();
  return result(
    `Battery capacity ${cap} kWh`,
    `Current capacity is ${currentCap} kWh; this scenario models ${cap} kWh.`,
    baseline, variant,
    [...SHARED_ASSUMPTIONS, `Charge/discharge rate stays at the configured ${settingsModule.getSettings().battery.maxRateKw} kW \u2014 capacity alone does not raise throughput.`, 'Round-trip efficiency losses and battery degradation are not modelled.', 'Capital cost is not modelled.'],
    `A larger battery only helps while there is surplus solar to fill it AND evening demand to empty it. Once daily surplus is fully captured, extra capacity sits unused and adds nothing.`
  );
}

// --- 6. Avoid the peak window entirely ------------------------------------
function avoidPeak() {
  const cfg = settingsModule.getSettings();
  const baseline = analytics.projectDay();
  const loads = cloneLoads();
  const moved = [];

  for (const l of loads) {
    if (l.critical) continue;
    const start = analytics.loadStartHour(l, true);
    const overlapsPeak = Array.from({ length: Math.ceil(l.duration) }, (_, i) => (start + i) % 24)
      .some((h) => h >= cfg.tariff.peakStartHour && h < cfg.tariff.peakEndHour);
    if (!overlapsPeak) continue;

    // Find the best legal start whose whole run sits outside the peak window.
    let best = null;
    for (let s = l.earliestStart; s <= l.latestFinish - l.duration; s++) {
      const inPeak = Array.from({ length: Math.ceil(l.duration) }, (_, i) => (s + i) % 24)
        .some((h) => h >= cfg.tariff.peakStartHour && h < cfg.tariff.peakEndHour);
      if (inPeak) continue;
      const solar = Array.from({ length: Math.ceil(l.duration) }, (_, i) =>
        require('./profiles').solarProfile((s + i) % 24)).reduce((a, b) => a + b, 0);
      if (!best || solar > best.solar) best = { start: s, solar };
    }
    if (best) { l.scheduledStart = best.start; moved.push(`${l.name} \u2192 ${String(best.start).padStart(2, '0')}:00`); }
  }

  if (!moved.length) {
    return { available: false, reason: 'No non-critical load currently runs inside the peak window, so there is nothing to move.' };
  }

  const variant = analytics.projectDay({ loads });
  return result(
    'Avoid the peak tariff window entirely',
    `Moves every non-critical load out of ${cfg.tariff.peakStartHour}:00\u2013${cfg.tariff.peakEndHour}:00: ${moved.join(', ')}.`,
    baseline, variant,
    [...SHARED_ASSUMPTIONS, 'Only non-critical loads are moved; critical loads stay where they are.', 'Each load is kept inside its own configured allowed window.', 'Assumes deferring these loads is operationally acceptable.'],
    `Peak energy is charged at \u20b9${cfg.tariff.peakRatePerKwh}/kWh versus \u20b9${cfg.tariff.normalRatePerKwh}/kWh normal and \u20b9${cfg.tariff.offPeakRatePerKwh}/kWh off-peak. Moving a run out of the peak band changes its price, and where the new slot has solar, it removes the grid import too.`
  );
}

// --- Natural-language entry point used by the AI tool layer ---------------
function run(spec) {
  const kind = String(spec && spec.type || '').toLowerCase();
  switch (kind) {
    case 'reduce_appliance_hours': return reduceApplianceHours(spec.loadId, spec.hours);
    case 'shift_appliance': return shiftAppliance(spec.loadId, spec.startHour);
    case 'tariff_change': return tariffChange(spec.percent);
    case 'change_solar': return changeSolar(spec.multiplier);
    case 'change_battery': return changeBattery(spec.capacityKwh);
    case 'avoid_peak': return avoidPeak();
    default:
      return {
        available: false,
        reason: `Unknown scenario type "${spec && spec.type}".`,
        supported: ['reduce_appliance_hours', 'shift_appliance', 'tariff_change', 'change_solar', 'change_battery', 'avoid_peak'],
      };
  }
}

module.exports = { run, reduceApplianceHours, shiftAppliance, tariffChange, changeSolar, changeBattery, avoidPeak };
