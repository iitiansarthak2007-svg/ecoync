// engine/profiles.js
// Deterministic, physically-motivated profile functions.
// No Math.random() here on purpose: the same hour always produces the
// same base reading, so the simulation is reproducible and explainable
// during a live demo (SIH judges can be told exactly why a number is
// what it is).

function gaussian(x, mu, sigma) {
  return Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
}

// Deterministic "texture" so the line isn't a perfectly smooth curve,
// without using true randomness. Same hour -> same ripple, always.
function ripple(x, amp) {
  return amp * (0.6 * Math.sin(x * 7.3) + 0.4 * Math.sin(x * 17.1 + 1.3));
}

// hourFloat: 0..24 (can be fractional)
function solarProfile(hourFloat, maxKw = 7.5) {
  const h = ((hourFloat % 24) + 24) % 24;
  let base = 0;
  if (h > 5.5 && h < 19.5) {
    base = maxKw * Math.max(0, Math.sin((Math.PI * (h - 5.5)) / 14));
  }
  const value = base + ripple(h, base * 0.06);
  return Math.max(0, Math.round(value * 100) / 100);
}

function demandProfile(hourFloat) {
  const h = ((hourFloat % 24) + 24) % 24;
  const base = 1.35;
  const morning = 1.9 * gaussian(h, 8, 1.1);
  const midday = 0.6 * gaussian(h, 13, 1.6);
  const evening = 2.5 * gaussian(h, 20, 1.5);
  const value = base + morning + midday + evening + ripple(h, 0.06);
  return Math.max(0.2, Math.round(value * 100) / 100);
}

module.exports = { solarProfile, demandProfile, gaussian };
