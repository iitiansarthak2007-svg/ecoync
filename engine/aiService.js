// EcoSync AI — multi-provider failover + local fallback.
// The app never assumes any one free provider is unlimited. It tries several
// independently configured providers in sequence and finally falls back to
// EcoSync's deterministic, data-grounded responder. API keys stay server-side.

const TIMEOUT_MS = Number(process.env.AI_PROVIDER_TIMEOUT_MS || 12000);
const FAILURE_COOLDOWN_MS = Number(process.env.AI_PROVIDER_COOLDOWN_MS || 30000);
let lastProvider = 'local';
const providerCooldownUntil = new Map();

class AIError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AIError';
    this.code = code;
  }
}

const SYSTEM_PROMPT = `You are EcoSync AI, the energy-management assistant inside the EcoSync dashboard.

Your job is to explain the supplied EcoSync snapshot and make practical recommendations. The JSON context is the source of truth. Never invent readings, forecasts, tariff periods, battery limits, appliance details, or times.

CRITICAL ACCURACY RULES:
- Use ONLY numbers and facts present in the context.
- Do arithmetic carefully before stating a result. Show units.
- Never confuse battery charger maximum rate with actual available solar surplus. If solar is 5 kW and demand is 4.3 kW, only about 0.7 kW surplus is available for solar charging before other constraints.
- Never claim a target SOC will be reached by a specific time unless the forecast/context supports it.
- Respect battery minReservePct and maxRateKw. Do not recommend discharging below reserve.
- For charge/scheduling questions, inspect forecastNext6Hours and tariff. Prefer genuine solar surplus while considering peak tariff.
- For reduce-grid questions, prioritize flexible, non-critical loads toward stronger solar periods. Do not call a load non-critical unless critical=false.
- currentDecision is the deterministic EcoSync optimization decision. Explain it rather than contradicting it unless asked for a scenario comparison.
- If isSimulatedOrDemoData=true, clearly say the values are demo/simulated when relevant.
- If the context cannot answer something, say what data is missing instead of guessing.

STYLE:
- Answer the exact question first.
- Prefer a short direct answer followed by 2-4 compact bullets.
- Be practical and dashboard-friendly.
- Use ₹ for rupee costs when provided.
- Do not describe the heuristic forecast/optimization as trained machine learning.`;

function isCooling(name) {
  const until = providerCooldownUntil.get(name) || 0;
  return until > Date.now();
}

function cool(name) {
  providerCooldownUntil.set(name, Date.now() + FAILURE_COOLDOWN_MS);
}

function markSuccess(name) {
  providerCooldownUntil.delete(name);
  lastProvider = name;
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const detail = data?.error?.message || data?.message || data?.error || '';
      const code = res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? 'rate_limit' : 'api_error';
      throw new AIError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, code);
    }
    return data;
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (err.name === 'AbortError') throw new AIError('Provider timed out.', 'timeout');
    throw new AIError(`Network error: ${err.message}`, 'network');
  } finally {
    clearTimeout(timeout);
  }
}

async function openAICompatible(name, url, key, model, input, extraHeaders = {}, sys = SYSTEM_PROMPT) {
  if (!key) throw new AIError('Not configured.', 'not_configured');
  const data = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: input },
      ],
      temperature: 0.35,
      max_tokens: 900,
      stream: false,
    }),
  });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new AIError(`${name} returned an empty response.`, 'malformed');
  }
  return content.trim();
}

async function gemini(input, sys = SYSTEM_PROMPT) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AIError('Not configured.', 'not_configured');
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 900 },
    }),
  });
  const content = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!content) throw new AIError('Gemini returned an empty response.', 'malformed');
  return content;
}

async function cohere(input, sys = SYSTEM_PROMPT) {
  const key = process.env.COHERE_API_KEY;
  if (!key) throw new AIError('Not configured.', 'not_configured');
  const model = process.env.COHERE_MODEL || 'command-a-plus-05-2026';
  const data = await fetchJson('https://api.cohere.com/v2/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: input },
      ],
      temperature: 0.35,
      max_tokens: 900,
    }),
  });
  const content = data?.message?.content?.filter(x => x.type === 'text').map(x => x.text).join('').trim();
  if (!content) throw new AIError('Cohere returned an empty response.', 'malformed');
  return content;
}

async function tryProvider(name, fn) {
  if (isCooling(name)) throw new AIError('Provider is in short cooldown after a recent failure.', 'cooldown');
  try {
    const reply = await fn();
    markSuccess(name);
    return reply;
  } catch (err) {
    if (err.code !== 'not_configured' && err.code !== 'cooldown') cool(name);
    throw err;
  }
}

function providerStatus() {
  return {
    active: lastProvider,
    configured: {
      groq: !!process.env.GROQ_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
      mistral: !!process.env.MISTRAL_API_KEY,
      cerebras: !!process.env.CEREBRAS_API_KEY,
      sambanova: !!process.env.SAMBANOVA_API_KEY,
      cohere: !!process.env.COHERE_API_KEY,
      huggingface: !!process.env.HF_TOKEN,
      ollama: process.env.OLLAMA_ENABLED === 'true',
    },
    localFallback: true,
    order: ['groq', 'gemini', 'cerebras', 'sambanova', 'mistral', 'openrouter', 'huggingface', 'cohere', 'ollama', 'local'],
  };
}

function isConfigured() {
  const c = providerStatus().configured;
  return Object.values(c).some(Boolean);
}

async function ollama(input, sys = SYSTEM_PROMPT) {
  if (process.env.OLLAMA_ENABLED !== 'true') throw new AIError('Not configured.', 'not_configured');
  const url = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
  const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: input },
      ],
      stream: false,
      options: { temperature: 0.35 },
    }),
  });
  const content = data?.message?.content;
  if (!content) throw new AIError('Ollama returned an empty response.', 'malformed');
  return content.trim();
}

async function callExternal(input, sys = SYSTEM_PROMPT) {
  const errors = [];
  const providers = [
    ['groq', () => openAICompatible('Groq', 'https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, process.env.GROQ_MODEL || 'openai/gpt-oss-120b', input, {}, sys)],
    ['gemini', () => gemini(input, sys)],
    ['cerebras', () => openAICompatible('Cerebras', 'https://api.cerebras.ai/v1/chat/completions', process.env.CEREBRAS_API_KEY, process.env.CEREBRAS_MODEL || 'gpt-oss-120b', input, {}, sys)],
    ['sambanova', () => openAICompatible('SambaNova', 'https://api.sambanova.ai/v1/chat/completions', process.env.SAMBANOVA_API_KEY, process.env.SAMBANOVA_MODEL || 'gpt-oss-120b', input, {}, sys)],
    ['mistral', () => openAICompatible('Mistral', 'https://api.mistral.ai/v1/chat/completions', process.env.MISTRAL_API_KEY, process.env.MISTRAL_MODEL || 'mistral-small-latest', input, {}, sys)],
    ['openrouter', () => openAICompatible('OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_MODEL || 'openrouter/free', input, { 'HTTP-Referer': 'http://localhost:4600', 'X-Title': 'EcoSync AI' }, sys)],
    ['huggingface', () => openAICompatible('Hugging Face', 'https://router.huggingface.co/v1/chat/completions', process.env.HF_TOKEN, process.env.HF_MODEL || 'openai/gpt-oss-120b:fastest', input, {}, sys)],
    ['cohere', () => cohere(input, sys)],
    ['ollama', () => ollama(input, sys)],
  ];

  for (const [name, fn] of providers) {
    try {
      return await tryProvider(name, fn);
    } catch (err) {
      if (err.code !== 'not_configured' && err.code !== 'cooldown') {
        errors.push(`${name}: ${err.message}`);
      }
    }
  }
  const e = new AIError(errors.join(' | ') || 'No external AI providers are configured.', 'providers_unavailable');
  e.providerErrors = errors;
  throw e;
}

function round(n) { return Math.round(Number(n) * 100) / 100; }

// Honest, data-grounded fallback. It is intentionally narrow: it answers the
// common EcoSync questions without pretending to be a general LLM.
function localChat(userMessage, context) {
  lastProvider = 'local';
  const q = userMessage.toLowerCase();
  const c = context.current;
  const b = context.battery;
  const d = context.derived;
  const f = context.forecastNext6Hours || [];
  const demo = context.isSimulatedOrDemoData ? ' This is demo/simulated data.' : '';

  if (q.includes('charge') && q.includes('battery')) {
    if (c.solarKw > c.demandKw && b.socPct < 80) {
      return `Charge the battery while the current solar surplus is available.${demo}\n\n- Solar is ${round(c.solarKw)} kW versus ${round(c.demandKw)} kW demand, leaving about ${round(c.solarKw - c.demandKw)} kW surplus.\n- Battery is at ${round(b.socPct)}% SOC, with a target headroom of about ${round(d.chargeHeadroomTo80PctKwh)} kWh to 80%.\n- The charger can accept up to ${round(b.maxRateKw)} kW, but actual solar charging is limited by the available surplus.\n- Current EcoSync decision: ${context.currentDecision?.decision || 'not available'}.`;
    }
    return `Battery charging is not the strongest current opportunity.${demo}\n\n- Solar is ${round(c.solarKw)} kW and demand is ${round(c.demandKw)} kW.\n- Battery SOC is ${round(b.socPct)}%, with a ${round(b.minReservePct)}% reserve.\n- Current EcoSync decision: ${context.currentDecision?.decision || 'not available'}.`;
  }

  if (q.includes('reduce') && (q.includes('grid') || q.includes('usage'))) {
    const flexible = (context.flexibleLoads || []).filter(x => !x.critical && x.forcedStatus !== 'off');
    const names = flexible.slice(0, 3).map(x => `${x.name} (${x.powerKw} kW)`).join(', ');
    return `Reduce grid usage by shifting flexible, non-critical loads toward stronger solar periods.${demo}\n\n- Current solar: ${round(c.solarKw)} kW; demand: ${round(c.demandKw)} kW; grid import: ${round(c.gridImportKw)} kW.\n- Flexible non-critical loads available for shifting: ${names || 'none shown in the current context'}.\n- Keep the battery above its ${round(b.minReservePct)}% reserve.\n- The current deterministic EcoSync decision is ${context.currentDecision?.decision || 'not available'}.`;
  }

  if (q.includes('appliance') || q.includes('load') || q.includes('schedule')) {
    const best = f.filter(x => x.solar > x.demand).sort((a, z) => (z.solar - z.demand) - (a.solar - a.demand))[0];
    const flexible = (context.flexibleLoads || []).filter(x => !x.critical && x.forcedStatus !== 'off');
    return `For flexible appliances, prefer a forecast period with real solar surplus.${demo}\n\n- Best visible surplus in the next 6 forecast points: ${best ? `${best.hourLabel}, about ${round(best.solar - best.demand)} kW surplus` : 'no clear surplus window is shown'}.\n- Flexible loads: ${flexible.map(x => x.name).join(', ') || 'none shown'}.\n- Peak tariff window: ${d.peakWindow}.`;
  }

  if (q.includes('solar') || q.includes('demand') || q.includes('energy') || q.includes('flow')) {
    return `Current EcoSync energy flow:${demo}\n\n- Solar: ${round(c.solarKw)} kW\n- Demand: ${round(c.demandKw)} kW\n- Grid import: ${round(c.gridImportKw)} kW\n- Battery: ${round(b.socPct)}% SOC\n- Current decision: ${context.currentDecision?.decision || 'not available'}`;
  }

  if (q.includes('sav') || (q.includes('cost') && !q.includes('bill')) || q.includes('cosr')) {
    const costs = context.costs || {};
    return `Here's what EcoSync has tracked on cost so far today.${demo}\n\n- Energy cost so far: ₹${round(costs.energyCostSoFarRupees)}\n- Net cost so far (after any export credit): ₹${round(costs.netCostSoFarRupees)}\n- Potential savings so far vs. a no-solar/no-battery baseline: ₹${round(costs.potentialSavingsSoFarRupees)}\n- Current grid rate: ₹${round(c.gridPricePerKwh)}/kWh (${d.tariffPeriod} period).`;
  }

  if (q.includes('peak') || q.includes('tariff') || q.includes('off-peak') || q.includes('off peak')) {
    return `Tariff status right now:${demo}\n\n- Current period: ${d.tariffPeriod}.\n- Grid rate right now: ₹${round(c.gridPricePerKwh)}/kWh.\n- Peak window: ${d.peakWindow}.\n- Off-peak rate: ₹${round(context.tariff?.offPeakRatePerKwh)}/kWh, peak rate: ₹${round(context.tariff?.peakRatePerKwh)}/kWh.`;
  }

  if (q.includes('bill') || q.includes('monthly')) {
    const costs = context.costs || {};
    return `Monthly cost estimate, based on today's usage pattern.${demo}\n\n- Estimated monthly cost: ₹${round(costs.estimatedMonthlyCostRupees)}\n- Net cost so far today: ₹${round(costs.netCostSoFarRupees)}\n- This is a projection from current-day data, not a bill.`;
  }

  if (q.includes('co2') || q.includes('carbon') || q.includes('emission')) {
    const costs = context.costs || {};
    return `Carbon impact so far today.${demo}\n\n- CO2 reduction so far: ${round(costs.co2ReductionKgSoFar)} kg\n- Emission factor used: ${round(costs.co2FactorKgPerKwh)} kg CO2/kWh\n- Renewable utilization: ${round(c.renewableUtilizationPct)}%.`;
  }

  if (q.includes('alert') || q.includes('warning') || q.includes('notification')) {
    const alerts = context.recentAlerts || [];
    if (!alerts.length) return `No active alerts in the current context.${demo}`;
    const lines = alerts.slice(0, 5).map(a => `- [${a.severity}] ${a.time} — ${a.description} (${a.source})`).join('\n');
    return `Recent alerts:${demo}\n\n${lines}`;
  }

  if (q.includes('flexible') || (q.includes('which') && q.includes('load'))) {
    const flexible = (context.flexibleLoads || []).filter(x => !x.critical && x.forcedStatus !== 'off');
    if (!flexible.length) return `No flexible, non-critical loads are currently shown as available.${demo}`;
    const lines = flexible.map(x => `- ${x.name}: ${x.powerKw} kW, ${x.durationHours}h, priority ${x.priority}`).join('\n');
    return `Flexible non-critical loads available for shifting:${demo}\n\n${lines}`;
  }

  if (q.includes('export') || (q.includes('store') && q.includes('solar'))) {
    return `Export vs. store decision for the current solar surplus.${demo}\n\n- Solar: ${round(c.solarKw)} kW, demand: ${round(c.demandKw)} kW, surplus: ${round(d.solarBalanceKw)} kW.\n- Battery SOC: ${round(b.socPct)}% (headroom to 80%: ${round(d.chargeHeadroomTo80PctKwh)} kWh).\n- Current grid export: ${round(c.gridExportKw)} kW.\n- Generally, store in the battery first while it's below its target SOC and reserve; export only genuine leftover surplus.\n- Current EcoSync decision: ${context.currentDecision?.decision || 'not available'}.`;
  }

  return `I can answer from the EcoSync snapshot, but the local fallback only handles energy questions it can ground in the available data.${demo}\n\nTry asking about battery charging, reducing grid usage, solar/demand, or appliance scheduling.`;
}

async function callAI(input, context, fallbackFn) {
  try {
    return await callExternal(input);
  } catch (_) {
    return fallbackFn(context);
  }
}

async function chat(userMessage, context, history = []) {
  const conversation = history
    .map((h) => `${h.role === 'assistant' ? 'EcoSync AI' : 'User'}: ${String(h.content).slice(0, 2000)}`)
    .join('\n');
  const input = `Current EcoSync energy context (JSON, generated ${context.generatedAt}):\n${JSON.stringify(context)}\n\n` +
    (conversation ? `Recent conversation:\n${conversation}\n\n` : '') +
    `User's new question:\n${userMessage}`;
  return callAI(input, context, (ctx) => localChat(userMessage, ctx));
}

async function narrateForecast(context, forecastPoints) {
  const input = `Here is EcoSync's 24-hour solar/demand forecast as JSON: ${JSON.stringify(forecastPoints)}\n\nCurrent context: ${JSON.stringify(context.current)}\n\nWrite a 2-3 sentence plain-English summary of when solar will be highest, when demand will be highest, and one practical takeaway. Do not invent numbers.`;
  return callAI(input, context, (ctx) => {
    const peakSolar = forecastPoints.reduce((a, b) => (b.solar > a.solar ? b : a), forecastPoints[0]);
    const peakDemand = forecastPoints.reduce((a, b) => (b.demand > a.demand ? b : a), forecastPoints[0]);
    return `Solar is expected to peak around ${peakSolar.hourLabel} (~${peakSolar.solar} kW) and demand around ${peakDemand.hourLabel} (~${peakDemand.demand} kW). Use the stronger-solar period for flexible loads and battery charging where the optimizer permits.`;
  });
}

async function narrateSchedule(context, scheduleResult) {
  const input = `Here is EcoSync's scheduling-optimizer output as JSON: ${JSON.stringify(scheduleResult)}\n\nWrite a 2-4 sentence plain-English summary. State which loads should move, their recommended start times, and renewable/grid changes if provided. Never invent a time or savings figure.`;
  return callAI(input, context, () => `The optimizer recommends shifting flexible loads toward higher-solar periods. Renewable energy used: ${scheduleResult.totals?.renewableUsed ?? 'not provided'} kWh; estimated cost saved: ₹${scheduleResult.totals?.costSaved ?? 'not provided'}.`);
}

async function narrateRecommendations(context, recommendations) {
  const input = `Here are EcoSync's rule-based recommendations (JSON): ${JSON.stringify(recommendations)}\n\nContext: ${JSON.stringify(context.current)}\n\nWrite one friendly dashboard headline. Do not invent data.`;
  return callAI(input, context, () => recommendations[0]?.recommendation || 'No notable energy events right now.');
}

// Raw completion with a caller-supplied system prompt. Unlike chat(), this
// THROWS when every provider fails, so the agent layer can fall back to its
// own deterministic composer rather than silently getting generic text.
async function complete(systemPrompt, input) {
  return callExternal(input, systemPrompt);
}

module.exports = {
  complete,
  isConfigured,
  providerStatus,
  chat,
  narrateForecast,
  narrateSchedule,
  narrateRecommendations,
  AIError,
};
