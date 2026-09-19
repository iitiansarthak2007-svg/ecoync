// public/copilot.js
// EcoSync AI Copilot — frontend integration layer.
//
// PURELY ADDITIVE. It does not modify app.js or ecosyncAI.js: it attaches its
// own nav listeners (addEventListener stacks), renders into containers that
// exist only for it, and reuses app.js's global getJSON/postJSON so error
// handling and the connection banner stay consistent across the whole app.
//
// Every panel here is backed by a DETERMINISTIC endpoint, so all of it works
// with no AI provider configured and no internet connection.

(function () {
  'use strict';

  // --------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function n(v, d) { return Number(v == null ? 0 : v).toFixed(d == null ? 1 : d); }
  function el(id) { return document.getElementById(id); }

  // Basis badges are the core honesty affordance: every figure in the UI says
  // whether it was measured, modelled or forecast.
  const BASIS_LABEL = {
    observed: 'Measured', projection: 'Projected', modelled: 'Modelled',
    forecast: 'Forecast', configured: 'Configured', mixed: 'Mixed', stored: 'Stored',
  };
  function basisBadge(basis) {
    if (!basis) return '';
    const label = BASIS_LABEL[basis] || basis;
    return `<span class="basis-badge basis-${esc(basis)}" title="Where this figure came from">${esc(label)}</span>`;
  }
  function confBadge(conf) {
    if (!conf) return '';
    const label = typeof conf === 'string' ? conf : conf.label;
    const reason = typeof conf === 'string' ? '' : (conf.reason || '');
    return `<span class="conf-badge conf-${esc(label)}" title="${esc(reason)}">Confidence: ${esc(label)}</span>`;
  }

  // Minimal, safe markdown: **bold**, `code`, "- " bullets, _italic_.
  function md(text) {
    let s = esc(text);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    s = s.replace(/^- /gm, '\u2022 ');
    return s;
  }
  window.EcoSyncMarkdown = md; // shared with ecosyncAI.js

  // --------------------------------------------------------------------
  // 1. Dashboard copilot strip — score + headline finding + quick actions
  // --------------------------------------------------------------------
  let scoreExpanded = false;

  async function refreshCopilotStrip() {
    const host = el('copilot-strip');
    if (!host) return;
    const [score, insights] = await Promise.all([
      getJSON('/analytics/score'),
      getJSON('/insights'),
    ]);
    if (!score) { host.innerHTML = '<div class="empty">Copilot analysis unavailable \u2014 check the connection.</div>'; return; }

    const top = insights && insights.insights && insights.insights.length
      ? insights.insights.slice().sort((a, b) => ({ High: 0, Medium: 1, Low: 2 }[a.impact] - { High: 0, Medium: 1, Low: 2 }[b.impact]))[0]
      : null;

    const pct = Math.max(0, Math.min(100, score.score));
    const ring = `conic-gradient(var(--green) 0% ${pct}%, var(--line) ${pct}% 100%)`;

    host.innerHTML = `
      <div class="copilot-main">
        <div class="score-ring" style="background:${ring}" role="img" aria-label="Energy efficiency score ${pct} out of 100, grade ${esc(score.grade)}">
          <div class="score-ring-inner">
            <div class="score-num">${pct}</div>
            <div class="score-grade">Grade ${esc(score.grade)}</div>
          </div>
        </div>
        <div class="copilot-body">
          <div class="copilot-eyebrow">\u{1F331} EcoSync Copilot \u00b7 energy efficiency score ${confBadge(score.confidence)}</div>
          ${top ? `
            <div class="copilot-headline">${md(top.title)}</div>
            <div class="copilot-sub">${md(top.explanation)}</div>
            <div class="copilot-chips">
              <span class="ai-insight-chip priority-${top.impact === 'High' ? 'high' : top.impact === 'Medium' ? 'medium' : 'low'}">${esc(top.impact)} impact</span>
              ${basisBadge(top.basis)}
            </div>` : `
            <div class="copilot-headline">No issues detected in the current data.</div>
            <div class="copilot-sub">${esc(score.confidenceReason)}</div>`}
          <div class="btn-row copilot-actions">
            <button class="btn ghost small" id="btn-score-detail" aria-expanded="${scoreExpanded}">${scoreExpanded ? 'Hide' : 'Show'} score breakdown</button>
            <button class="btn ghost small" data-goto-panel="insights">All insights</button>
            <button class="btn ghost small" data-goto-panel="reports">Reports</button>
          </div>
        </div>
      </div>
      <div class="score-breakdown" id="score-breakdown" ${scoreExpanded ? '' : 'hidden'}>
        <div class="score-method">${esc(score.methodology)} ${esc(score.confidenceReason)}</div>
        ${score.components.map((c) => `
          <div class="score-comp">
            <div class="score-comp-head">
              <span class="score-comp-label">${esc(c.label)} ${basisBadge(c.basis)}</span>
              <span class="score-comp-score mono">${c.score}/100 <span class="score-weight">\u00d7${c.weight}%</span></span>
            </div>
            <div class="score-bar"><span style="width:${Math.max(0, Math.min(100, c.score))}%"></span></div>
            <div class="score-comp-why">${esc(c.explanation)}</div>
          </div>`).join('')}
      </div>`;

    const btn = el('btn-score-detail');
    if (btn) btn.addEventListener('click', () => {
      scoreExpanded = !scoreExpanded;
      const bd = el('score-breakdown');
      if (bd) bd.hidden = !scoreExpanded;
      btn.textContent = (scoreExpanded ? 'Hide' : 'Show') + ' score breakdown';
      btn.setAttribute('aria-expanded', String(scoreExpanded));
    });
  }

  // Lets copilot buttons drive the existing nav without duplicating its logic:
  // it simply clicks the real nav button, so app.js's handler runs unchanged.
  document.addEventListener('click', (e) => {
    const t = e.target.closest ? e.target.closest('[data-goto-panel]') : null;
    if (!t) return;
    const real = document.querySelector(`.navbtn[data-panel="${t.dataset.gotoPanel}"]`);
    if (real) real.click();
  });

  // --------------------------------------------------------------------
  // 2. AI Insights Center
  // --------------------------------------------------------------------
  let insightFilter = 'all';
  let insightCache = null;

  const CATEGORY_LABEL = {
    all: 'All', daily: 'Daily', cost: 'Cost', efficiency: 'Efficiency',
    solar: 'Solar', battery: 'Battery', anomalies: 'Anomalies',
    scheduling: 'Scheduling', savings: 'Savings',
  };

  async function refreshInsights() {
    const list = el('insights-list');
    if (!list) return;
    const data = await getJSON('/insights');
    if (!data) { list.innerHTML = '<div class="empty">Insights unavailable \u2014 check the connection.</div>'; return; }
    insightCache = data;
    renderInsightFilters();
    renderInsightList();
  }

  function renderInsightFilters() {
    const host = el('insight-filters');
    if (!host || !insightCache) return;
    const cats = ['all'].concat(insightCache.categories || []);
    host.innerHTML = cats.map((c) => {
      const count = c === 'all' ? insightCache.count : (insightCache.byCategory[c] || []).length;
      return `<button class="btn ${insightFilter === c ? '' : 'ghost'} small" data-insight-cat="${esc(c)}">${esc(CATEGORY_LABEL[c] || c)} (${count})</button>`;
    }).join('');
    host.querySelectorAll('[data-insight-cat]').forEach((b) => {
      b.addEventListener('click', () => { insightFilter = b.dataset.insightCat; renderInsightFilters(); renderInsightList(); });
    });
  }

  function renderInsightList() {
    const list = el('insights-list');
    if (!list || !insightCache) return;
    const items = insightFilter === 'all' ? insightCache.insights : (insightCache.byCategory[insightFilter] || []);
    if (!items.length) { list.innerHTML = '<div class="empty">No insights in this category right now.</div>'; return; }

    list.innerHTML = items.map((i) => `
      <div class="card insight-card impact-${esc(String(i.impact).toLowerCase())}">
        <div class="insight-head">
          <div class="insight-title">${md(i.title)}</div>
          <div class="insight-tags">
            <span class="ai-insight-chip priority-${i.impact === 'High' ? 'high' : i.impact === 'Medium' ? 'medium' : 'low'}">${esc(i.impact)} impact</span>
            ${basisBadge(i.basis)}${confBadge(i.confidence)}
          </div>
        </div>
        <div class="insight-body">${md(i.explanation)}</div>
        ${i.supportingData ? `<div class="insight-data">${Object.entries(i.supportingData)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, v]) => `<span class="data-pill"><span class="dk">${esc(k.replace(/([A-Z])/g, ' $1').replace(/^./, (m) => m.toUpperCase()))}</span><span class="dv mono">${esc(v)}</span></span>`).join('')}</div>` : ''}
        <div class="insight-action"><strong>Recommended:</strong> ${md(i.recommendedAction)}</div>
        ${i.confidence && i.confidence.reason ? `<div class="insight-why">${esc(i.confidence.reason)}</div>` : ''}
      </div>`).join('');
  }

  // --------------------------------------------------------------------
  // 3. Reports
  // --------------------------------------------------------------------
  let reportPeriod = 'daily';

  async function refreshReport(period) {
    reportPeriod = period || reportPeriod;
    const body = el('report-body');
    if (!body) return;
    document.querySelectorAll('#report-controls [data-report]').forEach((b) => {
      b.classList.toggle('ghost', b.dataset.report !== reportPeriod);
    });
    body.innerHTML = '<div class="empty">Building report\u2026</div>';
    const r = await getJSON('/report?period=' + encodeURIComponent(reportPeriod));
    if (!r || r.available === false) {
      body.innerHTML = `<div class="empty">${esc((r && r.reason) || 'Report unavailable.')}</div>`;
      return;
    }

    const row = (label, value, unit) => `<div class="rep-row"><span class="rep-k">${esc(label)}</span><span class="rep-v mono">${esc(value)}${unit ? ' ' + esc(unit) : ''}</span></div>`;

    body.innerHTML = `
      <div class="card report-header">
        <div class="rep-title">${esc(r.title)}</div>
        <div class="rep-meta">Generated ${esc(new Date(r.generatedAt).toLocaleString())} \u00b7 clock ${esc(r.clock)} \u00b7 source ${esc(r.dataSource)}</div>
        ${r.isSimulatedOrDemoData ? `<div class="rep-disclaimer">${esc(r.disclaimer)}</div>` : ''}
        <div class="rep-coverage">${esc(r.dataCoverage.note)} Observed readings: ${r.dataCoverage.observedReadings}.</div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="rep-section">Energy ${basisBadge(r.energy.basis)}</div>
          ${row('Total demand', n(r.energy.totalDemandKwh, 1), 'kWh')}
          ${row('Solar generated', n(r.energy.solarGeneratedKwh, 1), 'kWh')}
          ${row('Grid import', n(r.energy.gridImportKwh, 1), 'kWh')}
          ${row('Renewable utilization', n(r.energy.renewableUtilizationPct, 0), '%')}
          ${row('Peak demand', n(r.energy.peakDemandKw, 2) + ' kW', r.energy.peakDemandAt ? 'at ' + r.energy.peakDemandAt : '')}
          ${r.energy.observedSoFar && !r.energy.observedSoFar.unavailable
            ? `<div class="rep-note">Measured so far (${esc(r.energy.observedSoFar.window)}): ${n(r.energy.observedSoFar.demandKwh, 1)} kWh demand, peak ${n(r.energy.observedSoFar.peakDemandKw, 2)} kW.</div>`
            : `<div class="rep-note">${esc((r.energy.observedSoFar && r.energy.observedSoFar.unavailable) || '')}</div>`}
        </div>

        <div class="card">
          <div class="rep-section">Cost ${basisBadge(r.cost.basis)}</div>
          ${row('Projected cost', '\u20b9' + n(r.cost.projectedRupees, 0))}
          ${row('Projected net (after export)', '\u20b9' + n(r.cost.projectedNetRupees, 0))}
          ${row('Measured so far', '\u20b9' + n(r.cost.observedSoFarRupees, 2))}
          ${row('Estimated monthly', '\u20b9' + n(r.cost.estimatedMonthlyRupees, 0))}
          ${row('Saved vs baseline', '\u20b9' + n(r.cost.savingsVsBaselineRupees, 2))}
          ${r.cost.budget ? `<div class="rep-note ${r.cost.budget.onTrack ? 'ok' : 'warn'}">Budget \u20b9${n(r.cost.budget.budgetRupees, 0)}: ${esc(r.cost.budget.note)}</div>` : ''}
        </div>
      </div>

      <div class="section-title">Appliances ${basisBadge(r.appliances.basis)}</div>
      <p class="lede">${esc(r.appliances.basisNote)}</p>
      <div class="table-wrap card">
        <table>
          <thead><tr><th>Appliance</th><th>kWh/day</th><th>Cost/period</th><th>Share</th><th>Solar</th><th>Start</th></tr></thead>
          <tbody>
            ${r.appliances.items.map((a) => `<tr>
              <td>${esc(a.name)}${a.critical ? ' <span class="badge">critical</span>' : ''}${a.runsInPeak ? ' <span class="badge off">peak</span>' : ''}</td>
              <td class="mono">${n(a.energyKwhPerDay, 2)}</td>
              <td class="mono">\u20b9${n(a.costPerPeriodRupees, 0)}</td>
              <td class="mono">${n(a.sharePct, 1)}%</td>
              <td class="mono">${n(a.solarCoveragePct, 0)}%</td>
              <td class="mono">${esc(a.startLabel)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="section-title">Anomalies</div>
      <div class="card"><div class="rep-note">${esc(r.anomalies.summary)}</div>
        ${r.anomalies.items.slice(0, 5).map((a) => `<div class="rep-anom sev-${esc(a.severity)}"><strong>${esc(a.title)}</strong> \u2014 expected ${esc(a.expected)}, actual ${esc(a.actual)} ${esc(a.unit)}. ${esc(a.recommendedAction)} ${confBadge(a.confidence)}</div>`).join('')}
      </div>

      <div class="section-title">Savings opportunities</div>
      <div class="card">
        ${r.savingsOpportunities.length
          ? r.savingsOpportunities.map((o) => `<div class="rep-opp"><strong>${esc(o.title)}</strong> ${basisBadge(o.basis)}<div>${esc(o.detail)}</div><div class="rep-opp-val mono">${esc(o.estimatedValue)}</div></div>`).join('')
          : '<div class="rep-note">No further savings opportunities identified from the current data.</div>'}
      </div>

      <div class="section-title">Energy score</div>
      <div class="card">
        <div class="rep-row"><span class="rep-k">Overall</span><span class="rep-v mono">${r.energyScore.score}/100 (grade ${esc(r.energyScore.grade)}) ${confBadge(r.energyScore.confidence)}</span></div>
        <div class="rep-note">${esc(r.energyScore.confidenceReason)} Weakest area: ${esc(r.energyScore.weakest)}.</div>
      </div>`;
  }

  // --------------------------------------------------------------------
  // 4. Appliance analytics (Smart Loads panel)
  // --------------------------------------------------------------------
  async function refreshAppliances() {
    const host = el('appliance-analytics');
    if (!host) return;
    const d = await getJSON('/analytics/appliances');
    if (!d) { host.innerHTML = '<div class="empty">Appliance analysis unavailable.</div>'; return; }
    const note = el('appliance-basis-note');
    if (note) note.textContent = d.basisNote;

    host.innerHTML = `
      <div class="table-wrap card">
        <table>
          <thead><tr><th>Appliance</th><th>kWh/day</th><th>\u20b9/day</th><th>\u20b9/month</th><th>Solar</th><th>Share</th><th>Window</th></tr></thead>
          <tbody>
            ${d.appliances.map((a) => `<tr>
              <td>${esc(a.name)}${a.critical ? ' <span class="badge">critical</span>' : ''}</td>
              <td class="mono">${n(a.energyKwhPerDay, 2)}</td>
              <td class="mono">${n(a.estimatedCostRupeesPerDay, 2)}</td>
              <td class="mono">${n(a.estimatedCostRupeesPerMonth, 0)}</td>
              <td class="mono">${n(a.solarCoveragePct, 0)}%</td>
              <td class="mono">${n(a.shareOfDailyEnergyPct, 1)}%</td>
              <td>${esc(a.startLabel)}${a.runsInPeak ? ' <span class="badge off">peak</span>' : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card appliance-summary">
        <div><strong>Largest consumer:</strong> ${esc(d.largestConsumer || '\u2014')} \u00b7 <strong>Most expensive:</strong> ${esc(d.mostExpensive || '\u2014')}</div>
        <div class="rep-note">Always-on base load adds ${n(d.baseLoadKwhPerDay, 1)} kWh/day on top of these. ${esc(d.baseLoadNote)}</div>
      </div>`;
  }

  // --------------------------------------------------------------------
  // 5. What-if simulator (Scenario panel)
  // --------------------------------------------------------------------
  const PRESETS = [
    { label: 'Avoid peak hours', spec: { type: 'avoid_peak' } },
    { label: 'Prices +10%', spec: { type: 'tariff_change', percent: 10 } },
    { label: '1.5\u00d7 solar', spec: { type: 'change_solar', multiplier: 1.5 } },
    { label: 'Double battery', spec: { type: 'change_battery', capacityKwh: 40 } },
  ];

  function initWhatIf() {
    const host = el('whatif-presets');
    const custom = el('whatif-custom');
    if (!host || host.dataset.ready) return;
    host.dataset.ready = '1';

    host.innerHTML = PRESETS.map((p, i) => `<button class="btn ghost small" data-whatif="${i}">${esc(p.label)}</button>`).join('');
    host.querySelectorAll('[data-whatif]').forEach((b) => {
      b.addEventListener('click', () => runWhatIf(PRESETS[Number(b.dataset.whatif)].spec));
    });

    custom.innerHTML = `
      <div class="form-grid">
        <label>Appliance
          <select id="wi-load"><option value="ev">EV Charging</option><option value="laundry">Laundry</option><option value="pump">Water Pump</option><option value="hvac">HVAC</option></select>
        </label>
        <label>Action
          <select id="wi-action"><option value="shift_appliance">Move to hour</option><option value="reduce_appliance_hours">Run fewer hours</option></select>
        </label>
        <label>Value <input type="number" id="wi-value" value="12" min="0" max="23"></label>
      </div>
      <div class="btn-row"><button class="btn" id="btn-run-whatif">Run scenario</button></div>`;

    el('btn-run-whatif').addEventListener('click', () => {
      const type = el('wi-action').value;
      const v = Number(el('wi-value').value);
      runWhatIf(type === 'shift_appliance'
        ? { type, loadId: el('wi-load').value, startHour: v }
        : { type, loadId: el('wi-load').value, hours: v });
    });
  }

  async function runWhatIf(spec) {
    const out = el('whatif-result');
    if (!out) return;
    out.innerHTML = '<div class="empty">Running scenario\u2026</div>';
    const r = await postJSON('/whatif', spec);
    if (!r) { out.innerHTML = '<div class="empty">Could not reach the backend.</div>'; return; }
    if (r.available === false) { out.innerHTML = `<div class="empty">${esc(r.reason)}</div>`; return; }

    const d = r.difference;
    const cmp = (label, a, b, unit, lowerBetter) => {
      const delta = b - a;
      const good = lowerBetter ? delta < 0 : delta > 0;
      return `<div class="wi-metric">
        <div class="wi-label">${esc(label)}</div>
        <div class="wi-values"><span class="wi-before mono">${n(a, 2)}</span><span class="wi-arrow">\u2192</span><span class="wi-after mono">${n(b, 2)}</span><span class="wi-unit">${esc(unit)}</span></div>
        <div class="wi-delta ${Math.abs(delta) < 0.005 ? 'flat' : good ? 'good' : 'bad'}">${delta >= 0 ? '+' : ''}${n(delta, 2)} ${esc(unit)}</div>
      </div>`;
    };

    out.innerHTML = `
      <div class="card whatif-card">
        <div class="wi-head">
          <div class="wi-title">${esc(r.scenario)}</div>
          <div class="wi-headline ${d.savingsRupeesPerDay > 0 ? 'good' : d.savingsRupeesPerDay < 0 ? 'bad' : ''}">${esc(r.headline)}</div>
        </div>
        <div class="wi-desc">${esc(r.description)}</div>
        <div class="wi-grid">
          ${cmp('Grid import', r.current.gridImportKwh, r.alternative.gridImportKwh, 'kWh/day', true)}
          ${cmp('Net cost', r.current.netCostRupees, r.alternative.netCostRupees, '\u20b9/day', true)}
          ${cmp('Peak demand', r.current.peakDemandKw, r.alternative.peakDemandKw, 'kW', true)}
          ${cmp('Renewable use', r.current.renewableUtilizationPct, r.alternative.renewableUtilizationPct, '%', false)}
        </div>
        <div class="wi-why"><strong>Why:</strong> ${esc(r.explanation)}</div>
        <details class="wi-assumptions">
          <summary>Assumptions (${r.assumptions.length})</summary>
          <ul>${r.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        </details>
      </div>`;
  }

  // --------------------------------------------------------------------
  // 6. Settings: AI memory + provider health
  // --------------------------------------------------------------------
  async function refreshMemory() {
    const host = el('ai-memory-card');
    if (!host) return;
    const m = await getJSON('/memory');
    if (!m) { host.innerHTML = '<div class="empty">Preferences unavailable.</div>'; return; }

    host.innerHTML = `
      <div class="form-grid">
        ${m.preferences.map((p) => `
          <label title="${esc(p.usedFor)}">${esc(p.label)}
            ${p.type === 'enum'
              ? `<select data-mem="${esc(p.key)}"><option value="">\u2014 not set \u2014</option>${p.options.map((o) => `<option value="${esc(o)}" ${p.value === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
              : p.type === 'string'
              ? `<input type="text" data-mem="${esc(p.key)}" value="${esc(p.value == null ? '' : p.value)}" placeholder="Not set">`
              : `<input type="number" data-mem="${esc(p.key)}" value="${esc(p.value == null ? '' : p.value)}" placeholder="Not set">`}
            <span class="mem-why">${esc(p.usedFor)}</span>
          </label>`).join('')}
      </div>
      <div class="btn-row">
        <button class="btn" id="btn-save-memory">Save preferences</button>
        <button class="btn danger small" id="btn-clear-memory">Forget everything</button>
        <span class="pill" id="memory-note" style="display:none;">Saved \u2713</span>
      </div>
      <div class="rep-note">${esc(m.storageNote)} Currently storing ${m.storedCount} preference(s).</div>`;

    el('btn-save-memory').addEventListener('click', async () => {
      const payload = {};
      host.querySelectorAll('[data-mem]').forEach((i) => { payload[i.dataset.mem] = i.value === '' ? null : i.value; });
      const res = await postJSON('/memory', payload);
      const note = el('memory-note');
      if (note) {
        note.textContent = res && res.rejected && res.rejected.length
          ? `Saved, ${res.rejected.length} rejected` : 'Saved \u2713';
        note.style.display = 'inline-flex';
        setTimeout(() => { note.style.display = 'none'; }, 2500);
      }
      refreshMemory();
    });

    el('btn-clear-memory').addEventListener('click', async () => {
      await postJSON('/memory', { clear: true });
      refreshMemory();
    });
  }

  async function refreshProviderHealth() {
    const host = el('ai-provider-card');
    if (!host) return;
    const h = await getJSON('/ai/health');
    if (!h) { host.innerHTML = '<div class="empty">Provider status unavailable.</div>'; return; }
    host.innerHTML = `
      <div class="rep-row"><span class="rep-k">Providers configured</span><span class="rep-v mono">${h.providerCount ? esc(h.providersConfigured.join(', ')) : 'none'}</span></div>
      <div class="rep-row"><span class="rep-k">Last active provider</span><span class="rep-v mono">${esc(h.activeProvider)}</span></div>
      <div class="rep-row"><span class="rep-k">Analysis tools</span><span class="rep-v mono">${h.toolCount}</span></div>
      <div class="rep-row"><span class="rep-k">Failover order</span><span class="rep-v mono">${esc(h.fallbackOrder.join(' \u2192 '))}</span></div>
      <div class="rep-note">${esc(h.note)}</div>
      <div class="rep-note">API keys are read from server environment variables only. They are never sent to this page.</div>`;
  }

  // --------------------------------------------------------------------
  // Wiring — own nav listeners, never touching app.js's
  // --------------------------------------------------------------------
  const PANEL_REFRESH = {
    overview: refreshCopilotStrip,
    insights: refreshInsights,
    reports: () => refreshReport(reportPeriod),
    loads: refreshAppliances,
    scenario: () => { initWhatIf(); },
    settings: () => { refreshMemory(); refreshProviderHealth(); },
  };

  document.querySelectorAll('.navbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fn = PANEL_REFRESH[btn.dataset.panel];
      if (fn) fn();
    });
  });

  document.addEventListener('DOMContentLoaded', bindReportControls);
  bindReportControls();
  function bindReportControls() {
    document.querySelectorAll('#report-controls [data-report]').forEach((b) => {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', () => refreshReport(b.dataset.report));
    });
    const p = el('btn-print-report');
    if (p && !p.dataset.bound) { p.dataset.bound = '1'; p.addEventListener('click', () => window.print()); }
  }

  // Initial load — Overview is the active panel on page load.
  refreshCopilotStrip();
  // Slower than app.js's 3s KPI poll: these are heavier aggregate computations
  // and their inputs move slowly.
  setInterval(() => {
    const active = document.querySelector('.navbtn.active');
    if (active && active.dataset.panel === 'overview') refreshCopilotStrip();
  }, 15000);

  // Exposed so the chat's quick actions can jump to a panel.
  window.EcoSyncCopilot = { refreshCopilotStrip, refreshInsights, refreshReport, runWhatIf, basisBadge, confBadge };
})();
