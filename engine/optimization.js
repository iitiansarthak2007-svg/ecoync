// engine/optimization.js
// EcoSync Intelligent Optimization Engine.
// This is a transparent, rule-based decision engine — NOT a trained
// machine-learning model. It is deliberately explainable: every
// decision comes with the plain-English reason behind it.

function decide({ solar, demand, batterySoC, minReserve, batteryAvailable, gridAvailable }) {
  const net = solar - demand; // positive = surplus, negative = deficit
  const renewableFraction = demand > 0 ? Math.min(1, solar / demand) : 1;
  const score = Math.round(renewableFraction * 100);

  if (net >= 0) {
    if (batteryAvailable && batterySoC < 99) {
      return {
        decision: 'CHARGE BATTERY',
        reason: 'Solar generation exceeds current demand and battery capacity is available.',
        score,
        expectedImpact: `Storing ~${net.toFixed(1)} kW of surplus solar instead of exporting or curtailing it.`,
      };
    }
    if (gridAvailable) {
      return {
        decision: 'EXPORT GRID',
        reason: 'Solar exceeds demand and the battery is full, so the surplus is exported to the grid.',
        score,
        expectedImpact: `Exporting ~${net.toFixed(1)} kW instead of wasting it.`,
      };
    }
    return {
      decision: 'USE SOLAR',
      reason: 'Solar output is being used directly to meet demand.',
      score,
      expectedImpact: 'Demand is fully met by on-site generation.',
    };
  }

  const deficit = -net;
  if (batteryAvailable && batterySoC > minReserve) {
    return {
      decision: 'DISCHARGE BATTERY',
      reason: 'Renewable generation is insufficient and battery state of charge is above the minimum reserve.',
      score,
      expectedImpact: `Covering ~${deficit.toFixed(1)} kW from storage instead of the grid.`,
    };
  }
  if (gridAvailable) {
    return {
      decision: 'IMPORT GRID',
      reason: batteryAvailable
        ? 'Renewable generation and battery reserve are both insufficient, so the shortfall is imported from the grid.'
        : 'Battery is unavailable, so the shortfall is imported from the grid.',
      score,
      expectedImpact: `Importing ~${deficit.toFixed(1)} kW to keep the campus powered.`,
    };
  }
  return {
    decision: 'SHIFT LOAD',
    reason: 'No renewable, battery, or grid capacity is available. Flexible loads should be shifted or shed.',
    score,
    expectedImpact: 'Recommends deferring non-critical loads until a source is available.',
  };
}

module.exports = { decide };
