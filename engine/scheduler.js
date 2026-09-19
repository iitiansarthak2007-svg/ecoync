// engine/scheduler.js
// Finds the start hour, within a load's allowed window, whose duration-hour
// span captures the most forecast solar. This is a plain sliding-window
// maximum-sum search over the forecast array — not a black box.

function bestWindow(load, forecastPoints) {
  const { duration, earliestStart, latestFinish } = load;
  let bestStart = load.baselineStart;
  let bestSum = -Infinity;

  for (let start = earliestStart; start <= latestFinish - duration; start += 1) {
    let sum = 0;
    for (let h = start; h < start + duration; h++) {
      const hourMod = h % 24;
      const pt = forecastPoints.find((p) => Math.round(p.hour) % 24 === hourMod);
      sum += pt ? pt.solar : 0;
    }
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = start;
    }
  }
  return { start: bestStart, solarCaptured: Math.round(bestSum * 100) / 100 };
}

function solarAt(forecastPoints, hourMod) {
  const pt = forecastPoints.find((p) => Math.round(p.hour) % 24 === hourMod % 24);
  return pt ? pt.solar : 0;
}

function evaluateWindow(load, startHour, forecastPoints, gridPrice) {
  let renewableUsed = 0;
  for (let h = startHour; h < startHour + load.duration; h++) {
    const solar = solarAt(forecastPoints, h % 24);
    renewableUsed += Math.min(solar, load.power);
  }
  const totalEnergy = load.power * load.duration;
  const gridUsed = Math.max(0, totalEnergy - renewableUsed);
  return {
    renewableUsed: Math.round(renewableUsed * 100) / 100,
    gridEnergy: Math.round(gridUsed * 100) / 100,
    cost: Math.round(gridUsed * gridPrice * 100) / 100,
  };
}

function optimizeSchedule(loads, forecastPoints, gridPrice) {
  const results = loads.map((load) => {
    const before = evaluateWindow(load, load.baselineStart, forecastPoints, gridPrice);
    const win = bestWindow(load, forecastPoints);
    const after = evaluateWindow(load, win.start, forecastPoints, gridPrice);
    return {
      id: load.id,
      name: load.name,
      power: load.power,
      duration: load.duration,
      before: { start: load.baselineStart, ...before },
      after: { start: win.start, ...after },
      renewableGain: Math.round((after.renewableUsed - before.renewableUsed) * 100) / 100,
      costSaved: Math.round((before.cost - after.cost) * 100) / 100,
    };
  });

  const totals = results.reduce(
    (acc, r) => ({
      renewableUsed: acc.renewableUsed + r.after.renewableUsed,
      gridAvoided: acc.gridAvoided + (r.before.gridEnergy - r.after.gridEnergy),
      costSaved: acc.costSaved + r.costSaved,
    }),
    { renewableUsed: 0, gridAvoided: 0, costSaved: 0 }
  );

  return {
    results,
    totals: {
      renewableUsed: Math.round(totals.renewableUsed * 100) / 100,
      gridAvoided: Math.round(totals.gridAvoided * 100) / 100,
      costSaved: Math.round(totals.costSaved * 100) / 100,
    },
  };
}

module.exports = { optimizeSchedule, bestWindow, solarAt };
