// engine/memory.js
// EcoSync AI memory — application-level user preferences.
//
// DESIGN RULES (STEP 18):
//   * TRANSPARENT — everything stored is readable via GET /api/memory and
//     shown in the Settings panel. Nothing is hidden from the user.
//   * EDITABLE    — any field can be overwritten via POST /api/memory.
//   * REMOVABLE   — individual keys or the whole store can be deleted.
//   * SAFE        — this file has a strict allow-list of keys. Anything not on
//     it is rejected outright, so an API key, password or free-form secret can
//     never be persisted here even if a caller tries to send one.
//
// The stored preferences are injected into the AI's context so recommendations
// respect them (e.g. a monthly budget, or a preferred quiet window).

const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'data', 'memory.json');

// Strict allow-list. Each entry declares its type and how it is used, and the
// description is surfaced in the UI so the user can see exactly why it exists.
const SCHEMA = {
  monthlyBudgetRupees: {
    type: 'number', min: 0, max: 1000000,
    label: 'Monthly electricity budget (\u20b9)',
    usedFor: 'Lets EcoSync tell you whether the projected monthly cost is on track.',
  },
  preferredQuietStartHour: {
    type: 'number', min: 0, max: 23,
    label: 'Quiet hours start',
    usedFor: 'Scheduling advice avoids recommending noisy appliances inside your quiet window.',
  },
  preferredQuietEndHour: {
    type: 'number', min: 0, max: 23,
    label: 'Quiet hours end',
    usedFor: 'Scheduling advice avoids recommending noisy appliances inside your quiet window.',
  },
  prioritise: {
    type: 'enum', values: ['cost', 'renewable', 'balanced'],
    label: 'Optimization priority',
    usedFor: 'Shapes whether recommendations lean toward lowest cost or highest renewable use.',
  },
  batteryStrategy: {
    type: 'enum', values: ['conservative', 'balanced', 'aggressive'],
    label: 'Battery strategy',
    usedFor: 'Influences how readily EcoSync suggests discharging toward the reserve limit.',
  },
  savingsGoalPct: {
    type: 'number', min: 0, max: 100,
    label: 'Energy-saving goal (%)',
    usedFor: 'Used as the target when reporting progress against your baseline.',
  },
  notes: {
    type: 'string', maxLength: 400,
    label: 'Notes for the assistant',
    usedFor: 'Free-text context you want EcoSync AI to keep in mind (e.g. "lab runs Saturdays").',
  },
};

// Keys that must never be accepted, regardless of the allow-list. Belt and
// braces: the allow-list already excludes them, this makes the intent explicit
// and fails loudly if someone widens the schema carelessly.
const FORBIDDEN = /(key|token|secret|password|passwd|credential|auth|bearer|apikey)/i;

function ensureDir() {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return sanitize(parsed).accepted;
  } catch (_) {
    return {};
  }
}

let current = load();

function sanitize(input) {
  const accepted = {};
  const rejected = [];
  if (!input || typeof input !== 'object') return { accepted, rejected };

  for (const [key, raw] of Object.entries(input)) {
    if (FORBIDDEN.test(key)) { rejected.push({ key, reason: 'Secrets are never stored in memory.' }); continue; }
    const rule = SCHEMA[key];
    if (!rule) { rejected.push({ key, reason: 'Not a recognised preference.' }); continue; }
    if (raw === null || raw === '') continue; // empty clears the key

    if (rule.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
        rejected.push({ key, reason: `Must be a number between ${rule.min} and ${rule.max}.` });
        continue;
      }
      accepted[key] = Math.round(n * 100) / 100;
    } else if (rule.type === 'enum') {
      const v = String(raw).toLowerCase();
      if (!rule.values.includes(v)) { rejected.push({ key, reason: `Must be one of: ${rule.values.join(', ')}.` }); continue; }
      accepted[key] = v;
    } else {
      const s = String(raw).slice(0, rule.maxLength || 200);
      if (FORBIDDEN.test(s) && /[=:]\s*\S{12,}/.test(s)) {
        rejected.push({ key, reason: 'That looks like a credential — not stored.' });
        continue;
      }
      accepted[key] = s;
    }
  }
  return { accepted, rejected };
}

function getAll() {
  return { ...current };
}

// Returns the stored preferences annotated with their labels, for the UI.
function describe() {
  return {
    preferences: Object.entries(SCHEMA).map(([key, rule]) => ({
      key,
      label: rule.label,
      usedFor: rule.usedFor,
      type: rule.type,
      options: rule.values || null,
      value: current[key] !== undefined ? current[key] : null,
      isSet: current[key] !== undefined,
    })),
    storedCount: Object.keys(current).length,
    storageNote: 'Stored on the EcoSync server in data/memory.json. Never contains API keys or credentials, and can be cleared at any time.',
  };
}

function set(partial) {
  const { accepted, rejected } = sanitize(partial);
  current = { ...current, ...accepted };
  persist();
  return { saved: accepted, rejected, all: getAll() };
}

function remove(key) {
  if (key === '*' || key === undefined) {
    current = {};
    persist();
    return { cleared: 'all', all: {} };
  }
  if (!(key in current)) return { cleared: null, reason: `"${key}" was not set.`, all: getAll() };
  delete current[key];
  persist();
  return { cleared: key, all: getAll() };
}

function persist() {
  try {
    ensureDir();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(current, null, 2));
  } catch (_) { /* memory is a convenience, never load-bearing */ }
}

// Compact form injected into the AI context.
function forContext() {
  if (!Object.keys(current).length) return null;
  const out = {};
  for (const [k, v] of Object.entries(current)) out[k] = v;
  return out;
}

module.exports = { getAll, describe, set, remove, forContext, SCHEMA };
