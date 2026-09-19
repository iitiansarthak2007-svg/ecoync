// engine/settings.js
// All the "knobs" a judge or operator can change from the Settings page:
// tariff structure, emission factor, battery specs, building profile scale,
// and simulation speed. Persisted to disk so changes survive a restart.
// Nothing in the engine/ or routes layer hardcodes these values directly —
// they always read through getSettings().

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

const DEFAULTS = {
  tariff: {
    peakStartHour: 18,   // 6 PM
    peakEndHour: 22,     // 10 PM
    peakRatePerKwh: 11,
    offPeakRatePerKwh: 6.5,
    normalRatePerKwh: 8,
    solarExportRatePerKwh: 3.5,
  },
  gridEmissionFactorKgPerKwh: 0.82, // CEA India grid-average-ish assumption; configurable, not asserted as exact
  battery: {
    capacityKwh: 20,
    minReservePct: 20,
    maxRateKw: 4,
  },
  buildingProfileScale: 1.0, // multiplies the simulated demand profile (models a bigger/smaller building)
  simulationSpeedMultiplier: 1.0, // multiplies the ambient sim acceleration
  dataSourceLabel: null, // set at read-time from env, not stored
};

function ensureDataDir() {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadSettings() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULTS, parsed);
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [] : {};
  for (const key of Object.keys(base)) {
    if (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], (override && override[key]) || {});
    } else {
      out[key] = override && override[key] !== undefined ? override[key] : base[key];
    }
  }
  return out;
}

let current = loadSettings();

function getSettings() {
  return current;
}

function saveSettings(partial) {
  current = deepMerge(current, partial || {});
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2));
  return current;
}

// Tariff rate applicable at a given fractional hour (0..24)
function tariffRateAt(hourFloat, settings) {
  const t = (settings || current).tariff;
  const h = ((hourFloat % 24) + 24) % 24;
  if (h >= t.peakStartHour && h < t.peakEndHour) return t.peakRatePerKwh;
  if (h < 6 || h >= 22) return t.offPeakRatePerKwh;
  return t.normalRatePerKwh;
}

module.exports = { getSettings, saveSettings, tariffRateAt, DEFAULTS };
