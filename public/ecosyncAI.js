// public/ecosyncAI.js
// EcoSync AI — chat assistant + dashboard AI Insight card + AI narrative
// enrichments on the Forecast and Smart Loads panels.
//
// This file is purely additive: it doesn't touch app.js, doesn't remove or
// override any existing behavior, and reuses app.js's own getJSON/postJSON
// helpers (loaded first, in the same global scope) so error handling and
// the connection banner stay consistent with the rest of the dashboard.
// It only ever talks to EcoSync's own backend (/api/chat, /api/ai/*) —
// no API key or Groq URL ever appears in this file.

(function () {
  const overlay = document.getElementById('ai-chat-overlay');
  const fab = document.getElementById('ai-fab');
  const closeBtn = document.getElementById('ai-chat-close');
  const clearBtn = document.getElementById('ai-chat-clear');
  const messagesEl = document.getElementById('ai-chat-messages');
  const suggestionsEl = document.getElementById('ai-chat-suggestions');
  const input = document.getElementById('ai-chat-input');
  const sendBtn = document.getElementById('ai-chat-send');

  if (!overlay || !fab) return; // markup not present — nothing to wire up

  const SUGGESTED_PROMPTS = [
    'Analyze my energy today',
    'When should I charge my battery?',
    'How can I reduce grid usage?',
    'What is the best time to run my appliances?',
    'Explain my current energy flow',
    'How much have I saved so far today?',
    'Am I in a peak tariff period right now?',
    'What is my estimated bill this month?',
    'How much CO2 have I saved today?',
    'Are there any active alerts?',
    'Which of my loads are flexible right now?',
    'Should I export or store my solar surplus?',
  ];

  // Quick actions call /api/ai/tool directly: a button with a fixed purpose
  // shouldn't pay for an LLM planning round-trip, and calling the tool means
  // the result is identical whether or not a provider is configured.
  const QUICK_ACTIONS = [
    { label: 'Optimize today', tool: 'optimizeSchedule' },
    { label: 'Find energy waste', tool: 'getStandbyAnalysis' },
    { label: 'Forecast', tool: 'getForecast', args: { horizon: '24h' } },
    { label: 'Find anomalies', tool: 'detectAnomalies' },
    { label: 'Analyze cost', tool: 'calculateEnergyCost' },
    { label: 'Energy score', tool: 'getEnergyScore' },
    { label: 'Generate report', tool: 'generateReport', args: { period: 'daily' } },
  ];

  let history = []; // [{role:'user'|'assistant', content}] — sent back for conversational context
  let lastUserMessage = null; // powers the retry affordance

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function openChat() {
    overlay.classList.add('open');
    if (!messagesEl.children.length) {
      renderQuickActions();
      renderSuggestions();
      appendMessage('assistant', "Hi, I'm EcoSync AI 🌱. Ask me about your solar, battery, demand, or schedule — I only use EcoSync's real (or clearly-labelled demo) data to answer.");
    }
    input.focus();
  }
  function closeChat() {
    overlay.classList.remove('open');
  }

  fab.addEventListener('click', openChat);
  closeBtn.addEventListener('click', closeChat);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeChat();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeChat();
  });

  clearBtn.addEventListener('click', () => {
    history = [];
    lastUserMessage = null;
    messagesEl.innerHTML = '';
    renderQuickActions();
    renderSuggestions();
    appendMessage('assistant', 'Chat cleared. What would you like to know?');
  });

  function renderQuickActions() {
    const host = document.getElementById('ai-quick-actions');
    if (!host) return;
    host.innerHTML = QUICK_ACTIONS
      .map((a, i) => `<button class="btn ghost small quick-action" type="button" data-qa="${i}">${escapeHtml(a.label)}</button>`)
      .join('');
    host.querySelectorAll('[data-qa]').forEach((b) => {
      b.addEventListener('click', () => runQuickAction(QUICK_ACTIONS[Number(b.dataset.qa)]));
    });
  }

  // Runs one deterministic tool and renders its result as a data card.
  async function runQuickAction(action) {
    appendMessage('user', action.label);
    showTyping();
    const res = await postJSON('/ai/tool', { tool: action.tool, args: action.args || {} });
    hideTyping();
    if (!res || res.ok === false || !res.result) {
      appendMessage('error', (res && res.error) || 'That action could not be completed.');
      return;
    }
    renderToolCard(action.label, res.tool, res.result);
  }

  // Compact, readable rendering of a raw tool result — the "data card" surface.
  function renderToolCard(title, tool, r) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg assistant ai-data-card';

    if (r.available === false) {
      wrap.innerHTML = `<div class="dc-title">${escapeHtml(title)}</div><div class="dc-unavailable">${escapeHtml(r.reason || 'No data available.')}</div>`;
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    const rows = [];
    const push = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push([k, v]); };

    switch (tool) {
      case 'optimizeSchedule':
        r.results.forEach((x) => push(x.name, `${String(x.before.start).padStart(2, '0')}:00 \u2192 ${String(x.after.start).padStart(2, '0')}:00 (\u20b9${x.costSaved} saved)`));
        push('Totals', `${r.totals.renewableUsed} kWh renewable \u00b7 \u20b9${r.totals.costSaved} saved`);
        break;
      case 'getStandbyAnalysis':
        push('Base load', `${r.baseLoadKw} kW`);
        push('Per day', `${r.baseLoadKwhPerDay} kWh`);
        push('Share of daily energy', `${r.baseLoadSharePct}%`);
        push('Overnight', `${r.overnightKwh} kWh`);
        break;
      case 'getForecast':
        push('Peak demand', `${r.predictedPeakDemand.kw} kW at ${r.predictedPeakDemand.hourLabel}`);
        push('Peak solar', `${r.predictedPeakSolar.kw} kW at ${r.predictedPeakSolar.hourLabel}`);
        push('Est. grid cost', `\u20b9${r.predictedGridCostRupees}`);
        push('Confidence', `${r.confidenceRange.nearest}% \u2192 ${r.confidenceRange.furthest}%`);
        break;
      case 'detectAnomalies':
        push('Summary', r.summary);
        (r.anomalies || []).slice(0, 4).forEach((a) => push(a.severity.toUpperCase(), `${a.title} \u2014 ${a.recommendedAction}`));
        break;
      case 'calculateEnergyCost':
        push('Spent so far', `\u20b9${r.observedSoFar.gridImportCostRupees}`);
        push('Projected day (net)', `\u20b9${r.projectedFullDay.netCostRupees}`);
        push('Estimated monthly', `\u20b9${r.estimatedMonthlyCostRupees}`);
        push('Current band', `${r.currentPeriod} at \u20b9${r.currentRatePerKwh}/kWh`);
        break;
      case 'getEnergyScore':
        push('Score', `${r.score}/100 (grade ${r.grade})`);
        r.components.forEach((c) => push(c.label, `${c.score}/100 \u00b7 ${c.valueLabel}`));
        break;
      case 'generateReport':
        push('Demand', `${r.energy.totalDemandKwh} kWh`);
        push('Solar', `${r.energy.solarGeneratedKwh} kWh`);
        push('Grid import', `${r.energy.gridImportKwh} kWh`);
        push('Net cost', `\u20b9${r.cost.projectedNetRupees}`);
        push('Score', `${r.energyScore.score}/100 (${r.energyScore.grade})`);
        push('Anomalies', r.anomalies.summary);
        break;
      default:
        Object.entries(r).slice(0, 8).forEach(([k, v]) => {
          if (typeof v === 'object') return;
          push(k.replace(/([A-Z])/g, ' $1').replace(/^./, (m) => m.toUpperCase()), v);
        });
    }

    const basis = r.basis ? `<span class="basis-badge basis-${escapeHtml(r.basis)}">${escapeHtml(r.basis)}</span>` : '';
    wrap.innerHTML = `<div class="dc-title">${escapeHtml(title)} ${basis}</div>` +
      `<div class="dc-rows">${rows.map(([k, v]) => `<div class="dc-row"><span class="dc-k">${escapeHtml(k)}</span><span class="dc-v mono">${escapeHtml(v)}</span></div>`).join('')}</div>` +
      (r.basisNote || r.note ? `<div class="dc-note">${escapeHtml(r.basisNote || r.note)}</div>` : '');
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderSuggestions() {
    suggestionsEl.innerHTML = SUGGESTED_PROMPTS.map((p) => `<button class="pill ai-chip" type="button">${escapeHtml(p)}</button>`).join('');
    suggestionsEl.querySelectorAll('.ai-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        input.value = chip.textContent;
        sendMessage();
      });
    });
  }

  function formatAssistantText(text) {
    // copilot.js publishes a slightly richer (still escape-first) renderer.
    // Fall back to the original minimal one if it hasn't loaded.
    if (typeof window.EcoSyncMarkdown === 'function') return window.EcoSyncMarkdown(text);
    let safe = escapeHtml(text);
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/^- /gm, '\u2022 ');
    return safe;
  }

  function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `ai-msg ${role}`;
    if (role === 'assistant' || role === 'error') {
      div.innerHTML = formatAssistantText(text);
    } else {
      div.textContent = text;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'ai-typing';
    div.id = 'ai-typing-indicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function hideTyping() {
    const el = document.getElementById('ai-typing-indicator');
    if (el) el.remove();
  }

  async function sendMessage(retryText) {
    const text = retryText != null ? retryText : input.value.trim();
    if (!text) return;
    if (retryText == null) {
      input.value = '';
      input.style.height = 'auto';
      appendMessage('user', text);
    }
    lastUserMessage = text;
    showTyping();
    sendBtn.disabled = true;

    // Send everything already in history (the reply-so-far), then push this
    // turn locally once we know the request actually went out.
    const res = await postJSON('/chat', { message: text, history });
    hideTyping();
    sendBtn.disabled = false;

    if (!res || res.error) {
      const errEl = appendMessage('error', (res && res.error) || 'EcoSync AI could not respond — check your connection or server configuration.');
      addRetry(errEl);
      return;
    }
    history.push({ role: 'user', content: text });
    const msgEl = appendMessage('assistant', res.reply);
    decorateAnswer(msgEl, res);
    history.push({ role: 'assistant', content: res.reply });
    if (history.length > 16) history = history.slice(-16);
  }

  // Appends the confidence rating and an inspectable tool trace beneath an
  // answer. The trace is the explainability surface: it shows exactly which
  // deterministic tools produced the figures in the reply.
  function decorateAnswer(msgEl, res) {
    if (!msgEl || !res) return;
    const bits = [];
    if (res.confidence) {
      bits.push(`<span class="conf-badge conf-${escapeHtml(res.confidence)}" title="${escapeHtml(res.confidenceReason || '')}">Confidence: ${escapeHtml(res.confidence)}</span>`);
    }
    if (res.isSimulatedOrDemoData) bits.push('<span class="basis-badge basis-modelled">Simulated data</span>');
    if (res.answeredBy === 'deterministic') bits.push('<span class="basis-badge basis-observed">Built-in engine</span>');

    const tools = (res.trace && res.trace.tools) || [];
    const foot = document.createElement('div');
    foot.className = 'ai-msg-meta';
    foot.innerHTML = bits.join(' ') +
      (tools.length ? ` <button class="ai-trace-toggle" type="button">Why? (${tools.length} source${tools.length > 1 ? 's' : ''})</button>` : '') +
      (tools.length ? `<div class="ai-trace" hidden>${res.confidenceReason ? `<div class="ai-trace-why">${escapeHtml(res.confidenceReason)}</div>` : ''}<ul>${tools.map((t) => `<li><code>${escapeHtml(t.tool)}</code>${t.available ? '' : ' <em>(no data)</em>'}</li>`).join('')}</ul><div class="ai-trace-why">Planned by: ${escapeHtml(res.trace.planner)} \u00b7 ${escapeHtml(res.trace.reasoning || '')}</div></div>` : '');
    msgEl.appendChild(foot);

    const toggle = foot.querySelector('.ai-trace-toggle');
    if (toggle) toggle.addEventListener('click', () => {
      const box = foot.querySelector('.ai-trace');
      box.hidden = !box.hidden;
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addRetry(errEl) {
    if (!errEl || !lastUserMessage) return;
    const btn = document.createElement('button');
    btn.className = 'btn ghost small ai-retry';
    btn.type = 'button';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => { btn.disabled = true; sendMessage(lastUserMessage); });
    errEl.appendChild(btn);
  }

  sendBtn.addEventListener('click', () => sendMessage());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });

  // ---------- Dashboard AI Insight card ----------
  async function refreshAIInsights() {
    const el = document.getElementById('ai-insight-card');
    if (!el) return;
    const res = await postJSON('/ai/recommendations', {});
    if (!res || res.error) {
      el.innerHTML = `<div class="empty">${escapeHtml((res && res.error) || 'AI insight unavailable right now.')}</div>`;
      return;
    }
    const chips = (res.recommendations || [])
      .slice(0, 3)
      .map((r) => `<span class="ai-insight-chip priority-${escapeHtml(r.priority)}">${escapeHtml(r.status.replace(/_/g, ' '))} · ${Math.round(r.confidence * 100)}%</span>`)
      .join('');
    el.innerHTML = `
      <div class="ai-insight-body">
        <div class="ai-insight-headline">${formatAssistantText(res.headline || 'No notable energy events right now.')}</div>
        <div class="ai-insight-chips">${chips}</div>
      </div>
      <button class="btn ai-open-chat-btn" id="ai-insight-ask-btn" type="button">🌱 Continue in chat<svg class="btn-arrow" viewBox="0 0 24 24" aria-hidden="true"><line x1="4" y1="12" x2="19" y2="12"/><polyline points="13,6 19,12 13,18"/></svg></button>`;
    const askBtn = document.getElementById('ai-insight-ask-btn');
    if (askBtn) askBtn.addEventListener('click', openChat);
  }

  // ---------- Forecast panel: AI narrative ----------
  async function refreshAIForecastNarrative() {
    const el = document.getElementById('ai-forecast-narrative');
    if (!el) return;
    el.innerHTML = '<div class="empty">Loading AI summary…</div>';
    const res = await postJSON('/ai/forecast', {});
    if (!res || res.error) {
      el.innerHTML = `<div class="empty">${escapeHtml((res && res.error) || 'AI summary unavailable.')}</div>`;
      return;
    }
    el.innerHTML = formatAssistantText(res.narrative);
  }

  // ---------- Smart Loads panel: AI explanation of the schedule ----------
  // Piggybacks on the existing "Optimize schedule" button rather than
  // adding a second one — clicking it already recomputes the schedule via
  // POST /api/schedule (app.js); this adds a second, independent request
  // for the AI's plain-English explanation of that same result.
  const optimizeBtn = document.getElementById('btn-optimize-schedule');
  if (optimizeBtn) {
    optimizeBtn.addEventListener('click', async () => {
      const el = document.getElementById('ai-schedule-narrative');
      if (!el) return;
      el.style.display = 'block';
      el.innerHTML = '<div class="empty">Asking EcoSync AI to explain the schedule…</div>';
      const res = await postJSON('/ai/schedule', {});
      if (!res || res.error) {
        el.innerHTML = `<div class="empty">${escapeHtml((res && res.error) || 'AI explanation unavailable.')}</div>`;
        return;
      }
      el.innerHTML = `<b>🌱 EcoSync AI:</b> ${formatAssistantText(res.narrative)}`;
    });
  }

  // Refresh the relevant AI panel whenever its tab is opened, without
  // touching app.js's own nav-button listener (addEventListener supports
  // multiple independent listeners on the same element).
  document.querySelectorAll('.navbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.panel === 'overview') refreshAIInsights();
      if (btn.dataset.panel === 'forecast') refreshAIForecastNarrative();
    });
  });

  // Initial load — the Overview panel is active by default on page load.
  refreshAIInsights();
  setInterval(refreshAIInsights, 20000); // slower than app.js's 3s poll: AI calls are comparatively expensive/rate-limited
})();
