// engine/aiAgent.js
// EcoSync AI Copilot — the orchestrator.
//
// A question is answered in three stages:
//
//   1. PLAN      Decide which deterministic tools are needed. An LLM planner
//                picks them when a provider is configured; a keyword planner
//                does the same job offline. Either way the OUTPUT is just a
//                list of tool names — the model never sees energy data yet, so
//                it cannot invent any at this stage.
//   2. EXECUTE   Run those tools (engine/aiTools.js). This produces every
//                number that will appear in the answer.
//   3. EXPLAIN   Hand the tool RESULTS to the model and ask it to explain them.
//                If no provider answers, a deterministic composer writes the
//                answer directly from the same results.
//
// The point of the split: the model's only job is language. Arithmetic,
// comparisons and data availability are decided by code, which is what makes
// "I don't have enough data to determine that" a reachable, honest answer
// rather than something the model has to be trusted to say.

const aiService = require('./aiService');
const aiTools = require('./aiTools');
const memory = require('./memory');
const { currentSnapshot } = require('./state');

const PLANNER_SYSTEM = `You are the tool planner for EcoSync, an energy-management dashboard.

Given a user's question, choose which of the available tools should run to answer it with real data.

Respond with ONLY a JSON object, no prose and no markdown fences:
{"tools":[{"tool":"toolName","args":{}}],"reasoning":"one short sentence"}

RULES:
- Choose 1 to 4 tools. Fewer is better. Never choose a tool whose data the question does not need.
- Use the exact tool names given. Never invent a tool.
- Supply args only where the tool documents them.
- For "what if" questions always use runWhatIf and set the correct type.
- For questions about a specific appliance, pass its loadId (ev, pump, laundry, hvac).
- If the question is not about energy at all, return {"tools":[],"reasoning":"not an energy question"}.`;

const EXPLAINER_SYSTEM = `You are EcoSync AI, the energy copilot inside the EcoSync dashboard.

You are given the user's question and the JSON RESULTS of deterministic tools that were run against the live application. Those results are your ONLY source of facts.

ABSOLUTE RULES:
- Never state a number that is not present in the tool results. Do not recompute, re-derive or "adjust" figures — quote them.
- Every result carries a "basis" field. Reflect it honestly:
    observed   -> measured/recorded readings
    projection -> a modelled estimate for a full day or period, NOT a measurement
    modelled   -> derived from the configured campus model, not sub-metered
    forecast   -> a heuristic prediction with decaying confidence
  When you quote a projected or modelled figure, say so in plain words at least once.
- If a result has "available": false, tell the user plainly that the data isn't available and relay the "reason". Then offer the "alternative" if one is given. NEVER fill the gap with an estimate.
- If isSimulatedOrDemoData or a DEMO/SIMULATION dataSource appears, mention that the figures come from EcoSync's simulation.
- Never describe the forecast or optimizer as trained machine learning. They are transparent heuristics.
- Never claim EcoSync controls physical hardware. It recommends; it does not switch appliances.
- Respect the battery's minimum reserve and maximum rate. Never recommend discharging below reserve.
- If user preferences are present, honour them and say when a recommendation follows one.

STYLE:
- Answer the exact question in the first sentence.
- Then 2-4 short bullets with the supporting figures and units.
- Always explain WHY a recommendation holds, referencing the data that drives it.
- Use Rs. amounts as given (they are Indian rupees). Keep it compact and dashboard-friendly.
- Do not list the tools you used or mention "tool results" — just answer.`;

// ---------------------------------------------------------------------------
// STAGE 1 — planning
// ---------------------------------------------------------------------------

// Deterministic planner. Used when no AI provider is available, and as a
// sanity net when the LLM planner returns nothing usable. Rules are ordered
// most-specific first.
const KEYWORD_RULES = [
  { re: /what if|whatif|suppose|instead of|if i (reduce|move|shift|add|install|avoid)/i, plan: (q) => [whatIfCall(q)] },
  { re: /report|summary of (my|the) (day|week|month)|weekly report|monthly report/i, plan: (q) => [{ tool: 'generateReport', args: { period: /week/i.test(q) ? 'weekly' : /month/i.test(q) ? 'monthly' : 'daily' } }] },
  { re: /anomal|unusual|strange|weird|spike|abnormal|wrong with/i, plan: () => [{ tool: 'detectAnomalies' }, { tool: 'getAlerts' }] },
  { re: /waste|standby|vampire|idle|overnight|night.*(usage|consumption)/i, plan: () => [{ tool: 'getStandbyAnalysis' }, { tool: 'detectAnomalies' }] },
  { re: /which appliance|what appliance|biggest|largest|most (power|energy|electricity)|appliance.*(cost|consum)|consumes the most/i, plan: () => [{ tool: 'getApplianceData' }, { tool: 'calculateEnergyCost' }] },
  { re: /optimi[sz]e|best time to run|when should i run|schedul/i, plan: () => [{ tool: 'optimizeSchedule' }, { tool: 'getForecast', args: { horizon: '24h' } }] },
  { re: /forecast|predict|tomorrow|next (hour|6|24|few) ?hours?|expect/i, plan: (q) => [{ tool: 'getForecast', args: { horizon: /next hour/i.test(q) ? 'next_hour' : /6 ?hour/i.test(q) ? '6h' : '24h' } }] },
  { re: /compare|versus|vs\.? last|this week.*last week|than (usual|normal|yesterday)/i, plan: () => [{ tool: 'comparePeriods' }, { tool: 'getHistoricalEnergy' }] },
  { re: /bill|monthly cost|estimate.*cost|how much.*cost|expensive|cost.*(today|month)/i, plan: () => [{ tool: 'calculateEnergyCost' }, { tool: 'getTariffData' }] },
  { re: /save|saving|reduce.*(cost|bill|grid)|cheaper|lower my/i, plan: () => [{ tool: 'calculateSavings' }, { tool: 'optimizeSchedule' }, { tool: 'getApplianceData' }] },
  { re: /score|efficien|how am i doing|rating|grade/i, plan: () => [{ tool: 'getEnergyScore' }] },
  { re: /batter|charge|discharge|soc|state of charge|storage/i, plan: () => [{ tool: 'getBatteryData' }, { tool: 'getCurrentEnergy' }, { tool: 'getForecast', args: { horizon: '6h' } }] },
  { re: /solar|panel|generation|pv|export/i, plan: () => [{ tool: 'getSolarData' }, { tool: 'getForecast', args: { horizon: '6h' } }] },
  { re: /peak|tariff|off.?peak|rate|price/i, plan: () => [{ tool: 'getTariffData' }, { tool: 'calculateEnergyCost' }] },
  { re: /alert|warning|notification|problem/i, plan: () => [{ tool: 'getAlerts' }, { tool: 'detectAnomalies' }] },
  { re: /why.*(high|increase|up|expensive|rose)/i, plan: () => [{ tool: 'comparePeriods' }, { tool: 'detectAnomalies' }, { tool: 'getApplianceData' }] },
  { re: /week/i, plan: () => [{ tool: 'getWeeklyEnergy' }] },
  { re: /month/i, plan: () => [{ tool: 'getMonthlyEnergy' }] },
  { re: /today|daily|day/i, plan: () => [{ tool: 'getDailyEnergy' }, { tool: 'getCurrentEnergy' }] },
];

const LOAD_IDS = { ev: /\bev\b|electric vehicle|car charg/i, laundry: /laundry|washing|washer/i, pump: /pump|water/i, hvac: /hvac|ac\b|air ?con|cooling|heating/i };

function detectLoadId(q) {
  for (const [id, re] of Object.entries(LOAD_IDS)) if (re.test(q)) return id;
  return null;
}

// Parses a natural-language what-if into a structured scenario spec.
function whatIfCall(q) {
  const loadId = detectLoadId(q);
  const num = (re) => { const m = q.match(re); return m ? Number(m[1]) : null; };

  if (/price|tariff|rate|electricity cost/i.test(q) && /increase|rise|go up|higher|decrease|fall|drop|cheaper|%/i.test(q)) {
    const pct = num(/(\d+(?:\.\d+)?)\s*%/) ?? 10;
    const down = /decrease|fall|drop|cheaper|lower/i.test(q);
    return { tool: 'runWhatIf', args: { type: 'tariff_change', percent: down ? -pct : pct } };
  }
  if (/install|add|more|bigger|double/i.test(q) && /solar|panel|pv/i.test(q)) {
    const mult = /double/i.test(q) ? 2 : (num(/(\d+(?:\.\d+)?)\s*(?:x|times)/) ?? 1.5);
    return { tool: 'runWhatIf', args: { type: 'change_solar', multiplier: mult } };
  }
  if (/install|add|bigger|larger/i.test(q) && /batter|storage/i.test(q)) {
    const cap = num(/(\d+(?:\.\d+)?)\s*kwh/i) ?? 40;
    return { tool: 'runWhatIf', args: { type: 'change_battery', capacityKwh: cap } };
  }
  if (/avoid|skip|stay out of|outside/i.test(q) && /peak/i.test(q)) {
    return { tool: 'runWhatIf', args: { type: 'avoid_peak' } };
  }
  if (/move|shift|run .* at|instead at/i.test(q) && loadId) {
    const hr = num(/(?:at|to)\s*(\d{1,2})\s*(?::00)?\s*(?:am|pm|o'clock|h)?/i);
    let startHour = hr;
    if (hr != null && /pm/i.test(q) && hr < 12) startHour = hr + 12;
    if (/solar hours|midday|noon|afternoon/i.test(q)) startHour = 12;
    return { tool: 'runWhatIf', args: { type: 'shift_appliance', loadId, startHour: startHour ?? 12 } };
  }
  if (/less|fewer|reduce|cut|shorter/i.test(q) && loadId) {
    const hrs = num(/(\d+(?:\.\d+)?)\s*(?:fewer\s*)?hours?/i) ?? 1;
    return { tool: 'runWhatIf', args: { type: 'reduce_appliance_hours', loadId, hours: hrs } };
  }
  // A what-if we can't parse: still give the user real ground to stand on.
  return { tool: 'getDailyEnergy' };
}

function keywordPlan(question) {
  const q = String(question);
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(q)) {
      const calls = rule.plan(q).filter(Boolean);
      if (calls.length) return { tools: calls, planner: 'keyword', reasoning: 'Matched EcoSync\'s built-in question patterns.' };
    }
  }
  return { tools: [{ tool: 'getCurrentEnergy' }, { tool: 'getDailyEnergy' }], planner: 'keyword', reasoning: 'General energy question — using the current snapshot and today\'s model.' };
}

function parsePlannerJSON(text) {
  if (typeof text !== 'string') return null;
  // Models sometimes wrap JSON in fences or prose; take the outermost object.
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!parsed || !Array.isArray(parsed.tools)) return null;
    const tools = parsed.tools
      .filter((t) => t && typeof t.tool === 'string' && aiTools.has(t.tool))
      .slice(0, 4)
      .map((t) => ({ tool: t.tool, args: (t.args && typeof t.args === 'object') ? t.args : {} }));
    return { tools, reasoning: String(parsed.reasoning || '').slice(0, 200) };
  } catch (_) {
    return null;
  }
}

async function plan(question) {
  if (aiService.isConfigured()) {
    try {
      const raw = await aiService.complete(
        PLANNER_SYSTEM,
        `Available tools:\n${aiTools.catalogueText()}\n\nUser question: ${question}`
      );
      const parsed = parsePlannerJSON(raw);
      if (parsed && parsed.tools.length) {
        return { tools: parsed.tools, planner: 'llm', reasoning: parsed.reasoning || 'Planned by the AI planner.' };
      }
      // Model answered but chose nothing usable — fall through to keywords
      // rather than answering with no data at all.
    } catch (_) {
      // Provider unavailable: the keyword planner is a full substitute.
    }
  }
  return keywordPlan(question);
}

// ---------------------------------------------------------------------------
// STAGE 3 — deterministic composer (used when no provider answers)
// ---------------------------------------------------------------------------
function composeLocally(question, toolResults) {
  const lines = [];
  const unavailable = [];

  for (const tr of toolResults) {
    const r = tr.result || {};
    if (r.available === false) { unavailable.push(r.reason || `${tr.tool} has no data.`); continue; }

    switch (tr.tool) {
      case 'getCurrentEnergy':
        lines.push(`**Right now (${r.clock})** — solar ${r.solarKw} kW, demand ${r.demandKw} kW, grid import ${r.gridImportKw} kW, battery ${r.batterySocPct}%. Tariff is ${r.tariffPeriod} at Rs.${r.gridPricePerKwh}/kWh. EcoSync's current decision: ${r.currentDecision ? r.currentDecision.decision : 'not available'}.`);
        break;
      case 'getApplianceData':
        lines.push(`**Appliances (modelled from the configured load list, not sub-metered)** — most expensive is ${r.mostExpensive}. ` +
          r.appliances.slice(0, 4).map((a) => `${a.name}: ${a.energyKwhPerDay} kWh/day, about Rs.${a.estimatedCostRupeesPerDay}/day, ${a.solarCoveragePct}% solar-covered${a.runsInPeak ? ', runs in peak' : ''}`).join('; ') + '.');
        break;
      case 'getStandbyAnalysis':
        lines.push(`**Base load** — ${r.baseLoadKw} kW runs continuously, which is ${r.baseLoadKwhPerDay} kWh/day and ${r.baseLoadSharePct}% of daily energy. ${r.note}`);
        break;
      case 'detectAnomalies':
        lines.push(`**Anomalies** — ${r.summary}` + (r.anomalies.length ? '\n' + r.anomalies.slice(0, 3).map((a) => `- [${a.severity}] ${a.title}: expected ${a.expected} ${a.unit}, actual ${a.actual}. ${a.recommendedAction} (confidence: ${a.confidence.label})`).join('\n') : ''));
        break;
      case 'optimizeSchedule':
        lines.push(`**Optimized schedule (projection)** — ${r.results.filter((x) => x.after.start !== x.before.start).map((x) => `${x.name} ${String(x.before.start).padStart(2, '0')}:00 -> ${String(x.after.start).padStart(2, '0')}:00 (Rs.${x.costSaved} saved)`).join('; ') || 'no load benefits from moving right now'}. Totals: ${r.totals.renewableUsed} kWh renewable used, ${r.totals.gridAvoided} kWh grid avoided, Rs.${r.totals.costSaved} saved. ${r.note}`);
        break;
      case 'getForecast':
        lines.push(`**Forecast (${r.horizon}, heuristic — not a trained model)** — peak demand around ${r.predictedPeakDemand.hourLabel} at ${r.predictedPeakDemand.kw} kW; peak solar around ${r.predictedPeakSolar.hourLabel} at ${r.predictedPeakSolar.kw} kW. Estimated grid cost over the horizon: Rs.${r.predictedGridCostRupees}. Confidence falls from ${r.confidenceRange.nearest}% to ${r.confidenceRange.furthest}%.`);
        break;
      case 'calculateEnergyCost':
        lines.push(`**Cost** — Rs.${r.observedSoFar.gridImportCostRupees} spent so far today (measured); a full day projects to Rs.${r.projectedFullDay.netCostRupees} net. Estimated monthly: Rs.${r.estimatedMonthlyCostRupees} (a projection, not a bill). Current band: ${r.currentPeriod} at Rs.${r.currentRatePerKwh}/kWh; peak window ${r.peakWindow}.`);
        break;
      case 'calculateSavings':
        lines.push(`**Savings** — Rs.${r.realisedSoFar.savingsVsBaselineRupees} saved so far versus the no-EcoSync baseline, and ${r.realisedSoFar.co2ReductionKg} kg CO2 avoided. Re-scheduling could still save about Rs.${r.stillAvailable.fromRescheduling.costSaved}/day.`);
        break;
      case 'getBatteryData':
        lines.push(`**Battery** — ${r.socPct}% of ${r.capacityKwh} kWh. Usable above the ${r.minReservePct}% reserve: ${r.usableAboveReserveKwh} kWh; headroom to full: ${r.headroomKwh} kWh. Max rate ${r.maxRateKw} kW. ${r.canDischarge ? 'It can discharge now.' : 'It is at reserve and cannot discharge further.'}`);
        break;
      case 'getSolarData':
        lines.push(`**Solar** — generating ${r.currentSolarKw} kW against ${r.currentDemandKw} kW demand (${r.surplusKw >= 0 ? 'surplus' : 'deficit'} ${Math.abs(r.surplusKw)} kW). Projected ${r.projectedDailyGenerationKwh} kWh/day, of which ${r.projectedSelfConsumedKwh} kWh is self-consumed. Export pays Rs.${r.exportRatePerKwh}/kWh versus Rs.${r.importRateNowPerKwh}/kWh to import. ${r.note}`);
        break;
      case 'getTariffData':
        lines.push(`**Tariff** — currently ${r.currentPeriod} at Rs.${r.currentRatePerKwh}/kWh. Peak ${r.peakWindow} at Rs.${r.tariff.peakRatePerKwh}, normal Rs.${r.tariff.normalRatePerKwh}, off-peak Rs.${r.tariff.offPeakRatePerKwh}.`);
        break;
      case 'getEnergyScore':
        lines.push(`**Energy score: ${r.score}/100 (grade ${r.grade}, ${r.confidence} confidence)** — ${r.confidenceReason}\n` + r.components.map((c) => `- ${c.label}: ${c.score}/100 (${c.weight}% weight) — ${c.valueLabel}`).join('\n') + `\nWeakest area: ${r.weakest.label}.`);
        break;
      case 'runWhatIf':
        lines.push(`**Scenario: ${r.scenario}** — ${r.headline}\n- ${r.description}\n- Grid import changes by ${r.difference.gridImportKwh} kWh/day; net cost by Rs.${r.difference.netCostRupees}/day; peak demand by ${r.difference.peakDemandKw} kW.\n- ${r.explanation}\n- Assumptions: ${r.assumptions.slice(0, 3).join(' ')}`);
        break;
      case 'comparePeriods':
        lines.push(`**Comparison (${r.windowLabel})** — ${r.verdict} Demand was ${r.demand.observedKwh} kWh against an expected ${r.demand.expectedKwh} kWh (${r.demand.deltaPct > 0 ? '+' : ''}${r.demand.deltaPct}%). Solar was ${r.solar.observedKwh} kWh against ${r.solar.expectedKwh} kWh expected. Peak demand ${r.peakDemandKw} kW at ${r.peakDemandAt}.`);
        break;
      case 'getDailyEnergy':
        lines.push(`**Today, modelled across a full 24 hours (a projection, not a measurement)** — ${r.demandKwh} kWh demand, ${r.solarGeneratedKwh} kWh solar generated, ${r.gridImportKwh} kWh imported, costing about Rs.${r.netCostRupees} net. Peak ${r.peakDemandKw} kW at ${r.peakDemandHourLabel}. Renewable utilization ${r.renewableUtilizationPct}%.`);
        break;
      case 'getWeeklyEnergy':
      case 'getMonthlyEnergy':
        lines.push(`**${r.days}-day projection** — ${r.demandKwh} kWh demand, ${r.gridImportKwh} kWh grid import, about Rs.${r.netCostRupees} net. ${r.basisNote}`);
        break;
      case 'getHistoricalEnergy':
        lines.push(`**Recorded readings (${r.fromLabel}-${r.toLabel}, ${r.readings} readings)** — ${r.demandKwh} kWh consumed, ${r.solarKwh} kWh generated, ${r.gridImportKwh} kWh imported. Peak ${r.peakDemandKw} kW at ${r.peakDemandAt}; average ${r.avgDemandKw} kW.`);
        break;
      case 'getAlerts':
        lines.push(r.count ? `**Alerts (${r.count})**\n` + r.alerts.slice(0, 4).map((a) => `- [${a.severity}] ${a.time} ${a.description} -> ${a.recommendedAction}`).join('\n') : '**Alerts** — none active right now.');
        break;
      case 'generateReport':
        lines.push(`**${r.title}** — ${r.energy.totalDemandKwh} kWh demand, ${r.energy.solarGeneratedKwh} kWh solar, ${r.energy.gridImportKwh} kWh grid, about Rs.${r.cost.projectedNetRupees} net. Energy score ${r.energyScore.score}/100 (${r.energyScore.grade}). ${r.anomalies.summary} Top opportunity: ${r.savingsOpportunities[0] ? r.savingsOpportunities[0].title + ' — ' + r.savingsOpportunities[0].estimatedValue : 'none identified'}.`);
        break;
      case 'getUserPreferences':
        if (!r.isEmpty) lines.push(`**Your saved preferences** — ${Object.entries(r.preferences).map(([k, v]) => `${k}: ${v}`).join(', ')}.`);
        break;
      default:
        break;
    }
  }

  if (!lines.length && unavailable.length) {
    return `I don't have enough data to answer that yet.\n\n${unavailable.map((u) => `- ${u}`).join('\n')}\n\nEcoSync needs to run for a little longer to build up readings. In the meantime I can describe the current snapshot, the modelled day, or run a what-if scenario.`;
  }
  if (!lines.length) {
    return "I can only answer from EcoSync's own energy data. Try asking about your current usage, appliance costs, the forecast, anomalies, savings, or a what-if scenario.";
  }

  let out = lines.join('\n\n');
  if (unavailable.length) out += `\n\nNot available: ${unavailable.join(' ')}`;
  out += '\n\n_(Answered by EcoSync\'s built-in analysis engine — no external AI provider responded, so this is the deterministic summary.)_';
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
async function ask(question, history = []) {
  const started = Date.now();
  const snap = currentSnapshot();

  const planned = await plan(question);
  const toolResults = aiTools.executeMany(planned.tools);

  const prefs = memory.forContext();
  const isSim = /SIMULATION|MANUAL|DEMO/i.test(snap.dataSource);

  // Confidence reported to the UI: driven by real data availability, not by
  // the model's self-assessment.
  const anyUnavailable = toolResults.some((t) => t.result && t.result.available === false);
  const onlyProjections = toolResults.length > 0 && toolResults.every((t) => {
    const b = t.result && t.result.basis;
    return b === 'projection' || b === 'modelled';
  });
  const confidence = anyUnavailable ? 'low' : onlyProjections ? 'medium' : 'high';
  const confidenceReason = anyUnavailable
    ? 'Some of the data needed for this question is not available, so part of the answer is missing rather than estimated.'
    : onlyProjections
    ? 'This answer rests on EcoSync\u2019s modelled projections rather than recorded measurements.'
    : 'This answer is grounded in recorded readings from the running system.';

  let reply;
  let provider = 'local';
  let answeredBy = 'deterministic';

  if (aiService.isConfigured() && toolResults.length) {
    const payload =
      `User question: ${question}\n\n` +
      (history.length ? `Recent conversation:\n${history.map((h) => `${h.role === 'assistant' ? 'EcoSync AI' : 'User'}: ${String(h.content).slice(0, 700)}`).join('\n')}\n\n` : '') +
      `System context: clock ${snap.hourLabel}, data source "${snap.dataSource}"${isSim ? ' (SIMULATED DATA)' : ''}.\n` +
      (prefs ? `User preferences: ${JSON.stringify(prefs)}\n` : '') +
      `\nTOOL RESULTS (the only facts you may use):\n${JSON.stringify(toolResults.map((t) => ({ tool: t.tool, args: t.args, result: t.result })))}`;
    try {
      reply = await aiService.complete(EXPLAINER_SYSTEM, payload);
      provider = aiService.providerStatus().active;
      answeredBy = 'llm';
    } catch (_) {
      reply = composeLocally(question, toolResults);
    }
  } else {
    reply = composeLocally(question, toolResults);
  }

  return {
    reply,
    confidence,
    confidenceReason,
    dataSource: snap.dataSource,
    isSimulatedOrDemoData: isSim,
    aiProvider: provider,
    answeredBy,
    // The tool trace is returned so the UI can show exactly what the answer
    // was built from — explainability the user can actually inspect.
    trace: {
      planner: planned.planner,
      reasoning: planned.reasoning,
      tools: toolResults.map((t) => ({ tool: t.tool, args: t.args, ok: t.ok !== false, ms: t.ms, available: !(t.result && t.result.available === false) })),
      totalMs: Date.now() - started,
    },
    data: toolResults.map((t) => ({ tool: t.tool, result: t.result })),
  };
}

module.exports = { ask, plan, keywordPlan, composeLocally };
