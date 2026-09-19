// engine/forecast.js
// "EcoSync Forecast Engine" — a transparent heuristic, not a trained model:
// next-day solar/demand is the time-of-day profile, nudged by the moving
// average of recent actual readings for that time of day. Confidence
// falls off the further ahead the forecast looks.

const { solarProfile, demandProfile } = require('./profiles');

function forecastNext24(currentHourFloat, history) {
  const points = [];
  for (let step = 1; step <= 24; step++) {
    const hour = (currentHourFloat + step) % 24;
    const baseSolar = solarProfile(hour);
    const baseDemand = demandProfile(hour);

    // Moving average nudge: look at recent history entries near this hour-of-day.
    const near = history.filter((p) => Math.abs(((p.hour - hour + 36) % 24) - 12) > 11.5);
    let solarAdj = baseSolar;
    let demandAdj = baseDemand;
    if (near.length) {
      const avgSolar = near.reduce((s, p) => s + p.solar, 0) / near.length;
      const avgDemand = near.reduce((s, p) => s + p.demand, 0) / near.length;
      solarAdj = baseSolar * 0.7 + avgSolar * 0.3;
      demandAdj = baseDemand * 0.7 + avgDemand * 0.3;
    }

    const confidence = Math.max(52, Math.round(92 - step * 1.4));
    points.push({
      hour: Math.round(hour * 100) / 100,
      hourLabel: `${String(Math.floor(hour)).padStart(2, '0')}:00`,
      solar: Math.round(solarAdj * 100) / 100,
      demand: Math.round(demandAdj * 100) / 100,
      confidence,
    });
  }
  return {
    engine: 'EcoSync Forecast Engine (time-of-day profile + moving average)',
    generatedAtHour: Math.round(currentHourFloat * 100) / 100,
    points,
  };
}

module.exports = { forecastNext24 };
