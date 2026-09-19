// engine/insightEngine.js
// EcoSync's real recommendation engine: transparent rules over the actual
// context from aiContext.js, in the same spirit as engine/optimization.js
// (explainable, deterministic, no external call). This is what powers the
// "AI Energy Insights" dashboard card by default, and it always works —
// with no internet connection and no GEMINI_API_KEY — which matters for a
// hackathon demo room. The Gemini-backed layer (aiService.js) sits on top
// of this for free-form chat and natural-language narration, never in
// place of it.

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function buildRecommendations(ctx) {
  const { current, battery, currentDecision } = ctx;
  const net = round2(current.solarKw - current.demandKw);
  const recs = [];

  if (net > 0.15) {
    const headroom = clamp01((100 - battery.socPct) / 100);
    recs.push({
      status: 'solar_surplus',
      priority: headroom > 0.15 ? 'high' : 'medium',
      recommendation: headroom > 0.15
        ? 'Solar generation is currently higher than demand. This is a good period for battery charging or flexible loads.'
        : 'Solar generation exceeds demand, but the battery is nearly full — a good window for flexible loads instead.',
      reason: `Solar (${current.solarKw.toFixed(1)} kW) exceeds demand (${current.demandKw.toFixed(1)} kW) by ${net.toFixed(1)} kW.`,
      confidence: round2(clamp01(0.6 + Math.min(net / 3, 0.35))),
    });
  }

  if (net <= 0 && battery.socPct <= battery.minReservePct + 10) {
    recs.push({
      status: 'battery_low',
      priority: battery.socPct <= battery.minReservePct ? 'high' : 'medium',
      recommendation: 'Battery is near its minimum reserve. Prioritize grid or solar over further discharge.',
      reason: `Battery state of charge (${battery.socPct}%) is close to the configured minimum reserve (${battery.minReservePct}%).`,
      confidence: 0.85,
    });
  } else if (net > 0 && battery.socPct < 95) {
    recs.push({
      status: 'battery_chargeable',
      priority: 'medium',
      recommendation: 'Battery charging can be prioritized while renewable generation is available.',
      reason: `${net.toFixed(1)} kW of surplus solar is available and the battery has room (${battery.socPct}% of capacity).`,
      confidence: 0.8,
    });
  }

  // Rough "typical" baseline used only to phrase a comparison, not to make
  // a decision — engine/profiles.js's demandProfile() is the real model.
  const typicalBaselineKw = 3.0;
  if (current.demandKw > typicalBaselineKw * 1.4) {
    recs.push({
      status: 'high_demand',
      priority: 'medium',
      recommendation: 'Current demand is higher than the normal baseline. Consider checking for an unscheduled high-draw load.',
      reason: `Demand (${current.demandKw.toFixed(1)} kW) is well above the typical baseline (~${typicalBaselineKw.toFixed(1)} kW).`,
      confidence: 0.7,
    });
  }

  if (current.gridImportKw > 0.2) {
    recs.push({
      status: 'grid_dependency',
      priority: current.gridImportKw > 1.5 ? 'high' : 'low',
      recommendation: 'Grid dependency is elevated. Consider shifting flexible loads to the high-solar period.',
      reason: `Importing ${current.gridImportKw.toFixed(1)} kW from the grid right now (renewable utilization: ${current.renewableUtilizationPct}%).`,
      confidence: 0.75,
    });
  }

  if (current.solarKw > 0 && current.solarKw < current.demandKw && net > -1) {
    recs.push({
      status: 'renewable_opportunity',
      priority: 'low',
      recommendation: 'Available solar can cover more of the current load — small demand-side shifts could raise renewable usage further.',
      reason: `Solar (${current.solarKw.toFixed(1)} kW) is close to covering demand (${current.demandKw.toFixed(1)} kW).`,
      confidence: 0.6,
    });
  }

  if (!recs.length && currentDecision) {
    recs.push({
      status: String(currentDecision.decision || 'stable').toLowerCase().replace(/\s+/g, '_'),
      priority: 'low',
      recommendation: currentDecision.reason,
      reason: currentDecision.expectedImpact || currentDecision.reason,
      confidence: round2(clamp01((currentDecision.score || 50) / 100)),
    });
  }

  return recs.slice(0, 4);
}

module.exports = { buildRecommendations };
