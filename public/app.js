const API = '/api';

// ---------- Connection status banner ----------
// Real network/server-error handling: previously a dropped connection or a
// 500 from the backend just threw an unhandled promise rejection and the
// panel silently stopped updating with no indication anything was wrong.
// Now every request funnels through here: on failure we show a visible
// banner and the request resolves to null so callers can bail out
// cleanly and keep showing the last good data instead of crashing mid-render.
let connDown = false;
function setConnBanner(down, message) {
  connDown = down;
  const el = document.getElementById('conn-banner');
  if (!el) return;
  el.style.display = down ? 'flex' : 'none';
  if (down) el.querySelector('.msg').textContent = message || 'Cannot reach the EcoSync backend. Retrying…';
}

async function getJSON(path) {
  try {
    const r = await fetch(API + path);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `Server responded with HTTP ${r.status}`);
    }
    setConnBanner(false);
    return await r.json();
  } catch (err) {
    setConnBanner(true, err.message || 'Network error reaching the EcoSync backend.');
    return null;
  }
}
async function postJSON(path, body) {
  try {
    const r = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      const parsed = await r.json().catch(() => ({}));
      throw new Error(parsed.error || `Server responded with HTTP ${r.status}`);
    }
    setConnBanner(false);
    return await r.json();
  } catch (err) {
    setConnBanner(true, err.message || 'Network error reaching the EcoSync backend.');
    return null;
  }
}

// ---------- Panel navigation ----------
const navButtons = document.querySelectorAll('.navbtn');
const panels = document.querySelectorAll('.panel');
// First non-canvas container each panel fills — used only to show a quick
// "Loading…" placeholder the first time a panel is opened, instead of a
// blank flash while its first fetch is in flight.
const PANEL_CONTAINER = {
  overview: 'dash-stats', loads: 'loads-list', demo: 'demo-log', battery: 'battery-stats',
  alerts: 'alerts-list', devices: 'devices-list', impact: 'impact-cards', settings: 'settings-liveapi-note',
};
navButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    navButtons.forEach((b) => b.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
    const containerId = PANEL_CONTAINER[btn.dataset.panel];
    if (containerId) {
      const el = document.getElementById(containerId);
      if (el && !el.innerHTML.trim()) el.innerHTML = '<div class="empty">Loading…</div>';
    }
    refreshActivePanel(btn.dataset.panel);
  });
});

function fmt(n, d = 1) { return Number(n ?? 0).toFixed(d); }

// Display-only: server keeps dataSource upper-case (used in a regex elsewhere),
// but long all-caps runs are harder to read, so render sentence case (fixes #4).
function sentenceCase(s) {
  const lower = String(s ?? '').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function decisionBadgeClass(decision) {
  if (!decision) return '';
  if (decision.includes('GRID')) return 'grid';
  if (decision.includes('SHIFT')) return 'warn';
  return '';
}

function renderDecisionCard(el, d) {
  if (!d || !d.decision) { el.innerHTML = '<div class="empty">No decision yet.</div>'; return; }
  el.innerHTML = `
    <div class="decision-badge ${decisionBadgeClass(d.decision)}">${d.decision}</div>
    <div class="decision-body">
      <div class="reason">${d.reason || ''}</div>
      <div class="impact">${d.expectedImpact || ''}</div>
    </div>
    <div class="decision-score">
      <div class="num">${d.score ?? '—'}</div>
      <div class="lab">renewable score</div>
    </div>`;
}

// ---------- Dashboard ----------
let historyChart, forecastChart;

// unit "₹" is a currency prefix (goes before the number, like real money does);
// physical units (kW, %, kg) stay as a suffix (fixes #11).
const PREFIX_UNITS = new Set(['₹']);

function statCard(label, value, unit, accentClass, sub, featured) {
  const valueHtml = PREFIX_UNITS.has(unit)
    ? `<span class="s-unit s-unit-prefix">${unit}</span>${value}`
    : `${value}${unit ? `<span class="s-unit">${unit}</span>` : ''}`;
  // every card gets an accent so the grid reads as one consistent set,
  // instead of some cards having a colour bar and others having none (fixes #9)
  const accent = accentClass || 'accent-neutral';
  return `<div class="card stat ${accent}${featured ? ' featured' : ''}">
    <div class="s-label">${label}</div>
    <div class="s-value">${valueHtml}</div>
    ${sub ? `<div class="s-sub">${sub}</div>` : ''}
  </div>`;
}

async function refreshTopbar(dash) {
  document.getElementById('pill-datasource').innerHTML = `<span class="dot"></span><span class="pill-caps">Source</span> ${sentenceCase(dash.dataSource)}`;
  document.getElementById('pill-clock').textContent = dash.hourLabel;
  document.getElementById('pill-mode').textContent = dash.mode + (dash.mode === 'DEMO' ? ` (${dash.demoStatus})` : '');
  document.getElementById('pill-updated').textContent = dash.lastUpdated
    ? 'last updated ' + new Date(dash.lastUpdated).toLocaleTimeString()
    : 'last updated —';
}

async function refreshOverview() {
  const dash = await getJSON('/dashboard');
  if (!dash) return;
  refreshTopbar(dash);

  document.getElementById('dash-stats').innerHTML =
    // North-star operational metrics get a "featured" treatment so the eye
    // lands here first, instead of all 12 cards competing equally (fixes #7)
    statCard('Solar generation', fmt(dash.solar), 'kW', 'accent-solar', null, true) +
    statCard('Battery SoC', fmt(dash.batterySoC, 0), '%', 'accent-battery', null, true) +
    statCard('Grid import', fmt(dash.gridImport), 'kW', 'accent-grid', null, true) +
    statCard('Energy demand', fmt(dash.demand), 'kW', '') +
    statCard('Grid export', fmt(dash.gridExport), 'kW', 'accent-grid') +
    statCard('Renewable utilization', fmt(dash.renewableUtilizationPct, 0), '%', 'accent-eco') +
    statCard('Grid import cost', fmt(dash.energyCostSoFar, 0), '₹', '') +
    statCard('Net cost (after export)', fmt(dash.netCostSoFar, 0), '₹', '') +
    statCard('Est. monthly cost', fmt(dash.estimatedMonthlyCost, 0), '₹', '', 'projected from current rate') +
    statCard('Potential savings', fmt(dash.potentialSavingsSoFar, 0), '₹', 'accent-eco', 'vs. no-EcoSync baseline') +
    statCard('Solar savings', fmt(dash.solarSavingsSoFar, 0), '₹', 'accent-solar') +
    statCard('CO₂ reduction', fmt(dash.co2ReductionKg, 1), 'kg', 'accent-eco', 'vs. no-EcoSync baseline');

  renderDecisionCard(document.getElementById('decision-card'), dash.decision);

  const flow = document.getElementById('energy-flow');
  flow.innerHTML = `
    <div class="flow-row">
      <div class="flow-node"><div class="fn-label">SOLAR</div><div class="fn-value">${fmt(dash.solar)} kW</div></div>
      <div class="flow-arrow" aria-hidden="true">→</div>
      <div class="flow-node flow-engine"><div class="fn-label">ECOSYNC ENGINE</div><div class="fn-value">${dash.decision ? dash.decision.decision : '—'}</div></div>
      <div class="flow-arrow" aria-hidden="true">→</div>
    </div>
    <div class="flow-row">
      <div class="flow-node"><div class="fn-label">LOAD</div><div class="fn-value">${fmt(dash.demand)} kW</div></div>
      <div class="flow-node"><div class="fn-label">BATTERY</div><div class="fn-value">${fmt(dash.batterySoC,0)}%</div></div>
      <div class="flow-node"><div class="fn-label">GRID</div><div class="fn-value">${dash.gridImport > 0 ? '+' + fmt(dash.gridImport) : '-' + fmt(dash.gridExport)} kW</div></div>
    </div>`;

  const energy = await getJSON('/energy');
  if (!energy) return;
  const labels = energy.history.map((h) => h.hourLabel);
  const solar = energy.history.map((h) => h.solar);
  const demand = energy.history.map((h) => h.demand);
  const batt = energy.history.map((h) => h.battery);

  if (!historyChart) {
    historyChart = new Chart(document.getElementById('historyChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Solar', data: solar, borderColor: '#f58a22', backgroundColor: '#f58a2222', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'kw' },
          { label: 'Demand', data: demand, borderColor: '#c1502e', tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'kw' },
          { label: 'Battery', data: batt, borderColor: '#0b9293', borderDash: [4, 3], tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'pct' },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } },
          kw: { position: 'left', title: { display: true, text: 'kW' } },
          pct: { position: 'right', min: 0, max: 100, title: { display: true, text: '% SoC' }, grid: { display: false } },
        },
      },
    });
  } else {
    historyChart.data.labels = labels;
    historyChart.data.datasets[0].data = solar;
    historyChart.data.datasets[1].data = demand;
    historyChart.data.datasets[2].data = batt;
    historyChart.update('none');
  }
}

// ---------- Forecast ----------
async function refreshForecast() {
  const fc = await getJSON('/forecast');
  if (!fc) return;
  document.getElementById('forecast-engine-label').textContent =
    fc.engine + '. Not a trained ML model — a transparent, explainable heuristic.';
  const labels = fc.points.map((p) => p.hourLabel);
  const solar = fc.points.map((p) => p.solar);
  const demand = fc.points.map((p) => p.demand);
  const nearConf = fc.points[0].confidence;
  const farConf = fc.points[fc.points.length - 1].confidence;
  document.getElementById('forecast-confidence-note').textContent =
    `Confidence is about ${nearConf}% for the next hour, falling to about ${farConf}% for the furthest hour forecast.`;

  if (!forecastChart) {
    forecastChart = new Chart(document.getElementById('forecastChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Solar forecast', data: solar, backgroundColor: '#f58a22', borderRadius: 2 },
          { label: 'Demand forecast', data: demand, backgroundColor: '#c1502e88', borderRadius: 2 },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { title: { display: true, text: 'kW' } } },
      },
    });
  } else {
    forecastChart.data.labels = labels;
    forecastChart.data.datasets[0].data = solar;
    forecastChart.data.datasets[1].data = demand;
    forecastChart.update('none');
  }
}

// ---------- Loads / Scheduler ----------
let overrideMode = 'AUTO';

async function refreshLoads() {
  // Sync the local override-mode flag with the server on every refresh —
  // otherwise a page reload (or opening this panel after the mode was
  // changed elsewhere) would show stale enable/disable state on the
  // On/Off/Auto buttons and the "MODE:" pill.
  const dash = await getJSON('/dashboard');
  if (!dash) return;
  overrideMode = dash.overrideMode || 'AUTO';
  document.getElementById('pill-override-mode').textContent = 'MODE: ' + overrideMode;
  document.getElementById('btn-toggle-override').textContent =
    overrideMode === 'AUTO' ? 'Switch to manual override' : 'Switch to auto';

  const loadsResp = await getJSON('/loads');
  if (!loadsResp) return;
  const { loads } = loadsResp;
  document.getElementById('loads-list').innerHTML = loads.map((l) => `
    <div class="load-row">
      <div><div class="lname">${l.name}</div><div class="ltag">${l.power} kW · ${l.duration}h · priority ${l.priority}${l.critical ? ' · critical' : ''}</div></div>
      <div>Baseline: <span class="mono">${String(l.baselineStart).padStart(2, '0')}:00</span></div>
      <div>Scheduled: <span class="mono">${l.scheduledStart != null ? String(l.scheduledStart).padStart(2, '0') + ':00' : '—'}</span></div>
      <div><span class="badge ${l.status.includes('ON') ? 'on' : l.status.includes('OFF') ? 'off' : l.status === 'SCHEDULED' ? 'sched' : ''}">${l.status}</span></div>
      <div class="btn-row">
        <button class="btn ghost small" data-load="${l.id}" data-force="on" ${overrideMode !== 'MANUAL' ? 'disabled' : ''}>On</button>
        <button class="btn ghost small" data-load="${l.id}" data-force="off" ${overrideMode !== 'MANUAL' || l.critical ? 'disabled' : ''}>Off</button>
        <button class="btn ghost small" data-load="${l.id}" data-force="null" ${overrideMode !== 'MANUAL' ? 'disabled' : ''}>Auto</button>
      </div>
    </div>`).join('');

  document.querySelectorAll('#loads-list [data-load]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const forced = btn.dataset.force === 'null' ? null : btn.dataset.force;
      const res = await postJSON('/simulation', { loadId: btn.dataset.load, forcedStatus: forced });
      if (res && res.error) alert(res.error);
      refreshLoads();
    });
  });
}

document.getElementById('btn-toggle-override').addEventListener('click', async () => {
  overrideMode = overrideMode === 'AUTO' ? 'MANUAL' : 'AUTO';
  await postJSON('/simulation', { overrideMode });
  document.getElementById('pill-override-mode').textContent = 'MODE: ' + overrideMode;
  document.getElementById('btn-toggle-override').textContent =
    overrideMode === 'AUTO' ? 'Switch to manual override' : 'Switch to auto';
  refreshLoads();
});

document.getElementById('btn-optimize-schedule').addEventListener('click', async () => {
  const el = document.getElementById('sched-result');
  el.innerHTML = '<div class="empty">Calculating optimal windows…</div>';
  const res = await postJSON('/schedule', {});
  if (!res) { el.innerHTML = '<div class="empty">Could not reach the backend — try again.</div>'; return; }
  el.innerHTML = `<div class="section-title">Optimized windows</div>` +
    res.results.map((r) => `
      <div class="card sched-result">
        <div class="lname">${r.name}</div>
        <div class="sched-compare">
          BEFORE <span class="mono">${String(r.before.start).padStart(2,'0')}:00</span>
          <span class="arrow">→</span>
          AFTER <span class="mono" style="color:#2f8f57">${String(r.after.start).padStart(2,'0')}:00</span>
          <span class="pill">+${fmt(r.renewableGain)} kWh renewable</span>
          <span class="pill">₹${fmt(r.costSaved)} saved</span>
        </div>
      </div>`).join('') +
    `<div class="card" style="margin-top:10px;">
       <b>Totals:</b> ${fmt(res.totals.renewableUsed)} kWh renewable used ·
       ${fmt(res.totals.gridAvoided)} kWh grid avoided ·
       ₹${fmt(res.totals.costSaved)} saved
     </div>`;
  refreshLoads();
});

// ---------- Scenario simulator ----------
const scenarioToggles = { solarAvailable: true, batteryAvailable: true, gridAvailable: true };
['s-solar', 's-demand', 's-batt', 's-price'].forEach((id) => {
  document.getElementById(id).addEventListener('input', (e) => {
    const map = { 's-solar': ['s-solar-val', ' kW', 1], 's-demand': ['s-demand-val', ' kW', 1], 's-batt': ['s-batt-val', '%', 0], 's-price': ['s-price-val', '/kWh', 1] };
    const [labelId, unit, dec] = map[id];
    const prefix = id === 's-price' ? '₹' : '';
    document.getElementById(labelId).textContent = prefix + Number(e.target.value).toFixed(dec) + unit;
  });
});
['t-solar', 't-battery', 't-grid'].forEach((id) => {
  document.getElementById(id).addEventListener('click', (e) => {
    const key = e.target.dataset.key;
    scenarioToggles[key] = !scenarioToggles[key];
    e.target.classList.toggle('on', scenarioToggles[key]);
  });
});
document.getElementById('btn-apply-scenario').addEventListener('click', async () => {
  const manualScenario = {
    solar: Number(document.getElementById('s-solar').value),
    demand: Number(document.getElementById('s-demand').value),
    batterySoc: Number(document.getElementById('s-batt').value),
    gridPrice: Number(document.getElementById('s-price').value),
    ...scenarioToggles,
  };
  await postJSON('/simulation', { manualScenario });
  const preview = await postJSON('/optimize', {
    solar: manualScenario.solar, demand: manualScenario.demand, batterySoC: manualScenario.batterySoc,
    batteryAvailable: manualScenario.batteryAvailable, gridAvailable: manualScenario.gridAvailable,
  });
  renderDecisionCard(document.getElementById('scenario-decision-card'), preview);
});
document.getElementById('btn-clear-scenario').addEventListener('click', async () => {
  await postJSON('/simulation', { manualScenario: null });
  document.getElementById('scenario-decision-card').innerHTML = '<div class="empty">Scenario cleared — EcoSync is back on the live simulation.</div>';
});

// ---------- Demo mode ----------
async function refreshDemo() {
  const dash = await getJSON('/dashboard');
  if (!dash) return;
  document.getElementById('demo-clock').textContent = dash.hourLabel;
  document.getElementById('demo-status-pill').textContent = dash.mode === 'DEMO' ? dash.demoStatus.toUpperCase() : 'NOT RUNNING (live ambient mode)';
  const energy = await getJSON('/energy');
  if (!energy) return;
  const log = energy.history.slice(-12).reverse();
  document.getElementById('demo-log').innerHTML = log.length
    ? log.map((h) => `<div class="demo-log-row"><span class="mono">${h.hourLabel}</span> — ${h.decision} · solar ${fmt(h.solar)} kW · demand ${fmt(h.demand)} kW · battery ${fmt(h.battery,0)}%</div>`).join('')
    : '<div class="empty">No readings yet — start the demo.</div>';
}
document.getElementById('btn-demo-start').addEventListener('click', async () => { await postJSON('/simulation', { demoAction: 'start' }); refreshDemo(); });
document.getElementById('btn-demo-pause').addEventListener('click', async () => { await postJSON('/simulation', { demoAction: 'pause' }); refreshDemo(); });
document.getElementById('btn-demo-reset').addEventListener('click', async () => { await postJSON('/simulation', { demoAction: 'reset' }); refreshDemo(); });
document.getElementById('btn-demo-exit').addEventListener('click', async () => { await postJSON('/simulation', { demoAction: 'exit' }); refreshDemo(); });

// ---------- Battery ----------
async function refreshBattery() {
  const b = await getJSON('/battery');
  if (!b) return;
  document.getElementById('battery-stats').innerHTML =
    statCard('State of charge', fmt(b.soc, 0), '%', 'accent-battery', b.status) +
    statCard('Capacity', fmt(b.capacityKwh, 0), 'kWh', '') +
    statCard('Minimum reserve', fmt(b.minReservePct, 0), '%', '') +
    statCard('Max charge rate', fmt(b.maxChargeRateKw, 1), 'kW', '') +
    statCard('Max discharge rate', fmt(b.maxDischargeRateKw, 1), 'kW', '') +
    statCard('Override mode', b.mode, '', '');
}

// ---------- Alerts ----------
async function refreshAlerts() {
  const alertsResp = await getJSON('/alerts');
  if (!alertsResp) return;
  const { alerts } = alertsResp;
  document.getElementById('alerts-list').innerHTML = alerts.length
    ? alerts.map((a) => `
      <div class="alert sev-${a.severity}">
        <div class="bar"></div>
        <div>
          <div class="a-title">${a.description}</div>
          <div class="a-meta">${a.source} · ${a.time}</div>
          <div class="a-action">${a.recommendedAction}</div>
        </div>
        <div class="a-sev">${a.severity}</div>
      </div>`).join('')
    : '<div class="empty">No anomalies detected right now.</div>';
}

// ---------- Devices ----------
async function refreshDevices() {
  const d = await getJSON('/devices');
  if (!d) return;
  document.getElementById('devices-note').textContent = d.note;
  document.getElementById('devices-list').innerHTML = d.devices.map((dev) => `
    <div class="card device-card">
      <div>
        <div class="device-name">${dev.name}</div>
        <div class="device-loc">${dev.location} · ${dev.id}</div>
        <div class="device-loc">Last seen ${dev.lastSeen} · source: ${dev.dataSource}</div>
      </div>
      <div class="device-status">${dev.status}</div>
    </div>`).join('');
}

// ---------- Impact ----------
async function refreshImpact() {
  const im = await getJSON('/impact');
  if (!im) return;
  document.getElementById('impact-cards').innerHTML = `
    <div class="card compare-card">
      <div class="c-label">Renewable utilization</div>
      <div class="compare-row"><span class="before">${im.renewableUtilizationPct.before}%</span>→<span class="after">${im.renewableUtilizationPct.after}%</span></div>
    </div>
    <div class="card compare-card">
      <div class="c-label">Grid import (kWh)</div>
      <div class="compare-row"><span class="before">${fmt(im.gridImport.before,1)}</span>→<span class="after">${fmt(im.gridImport.after,1)}</span></div>
    </div>
    <div class="card compare-card">
      <div class="c-label">Peak demand (kW)</div>
      <div class="compare-row"><span class="before">${fmt(im.peakDemandKw.before,1)}</span>→<span class="after">${fmt(im.peakDemandKw.after,1)}</span></div>
    </div>
    <div class="card compare-card">
      <div class="c-label">Energy cost (₹)</div>
      <div class="compare-row"><span class="before">${fmt(im.costRupees.before,0)}</span>→<span class="after">${fmt(im.costRupees.after,0)}</span></div>
    </div>`;
  document.getElementById('impact-assumptions').innerHTML =
    `CO₂ reduction so far: <b>${fmt(im.co2ReductionKg,1)} kg</b> (assumed grid factor ${im.assumptions.co2FactorKgPerKwh} kg/kWh) · grid price ₹${im.assumptions.gridPricePerKwhNow}/kWh.<br>${im.assumptions.baselineDefinition}`;
}

document.getElementById('btn-export-impact').addEventListener('click', () => {
  // Print-to-PDF export, no dependencies: styles.css has an @media print
  // rule that hides the sidebar/topbar/nav and prints just this panel,
  // so "Save as PDF" in the browser's print dialog gives judges a clean
  // one-page takeaway of the impact numbers.
  window.print();
});

// ---------- Settings ----------
async function refreshSettings() {
  const s = await getJSON('/settings');
  if (!s) return;
  document.getElementById('set-peak-start').value = s.tariff.peakStartHour;
  document.getElementById('set-peak-end').value = s.tariff.peakEndHour;
  document.getElementById('set-peak-rate').value = s.tariff.peakRatePerKwh;
  document.getElementById('set-normal-rate').value = s.tariff.normalRatePerKwh;
  document.getElementById('set-offpeak-rate').value = s.tariff.offPeakRatePerKwh;
  document.getElementById('set-export-rate').value = s.tariff.solarExportRatePerKwh;
  document.getElementById('set-co2').value = s.gridEmissionFactorKgPerKwh;
  document.getElementById('set-scale').value = s.buildingProfileScale;
  document.getElementById('set-sim-speed').value = s.simulationSpeedMultiplier;
  document.getElementById('set-batt-cap').value = s.battery.capacityKwh;
  document.getElementById('set-batt-reserve').value = s.battery.minReservePct;
  document.getElementById('set-batt-rate').value = s.battery.maxRateKw;

  const dash = await getJSON('/dashboard');
  if (!dash) return;
  const live = dash.liveApi;
  const note = document.getElementById('settings-liveapi-note');
  if (live.configured && live.connected) {
    note.innerHTML = `<span class="badge on">LIVE API CONNECTED</span> EcoSync is reading real values from your configured energy API.`;
  } else if (live.configured && !live.connected) {
    note.innerHTML = `<span class="badge off">LIVE API CONFIGURED BUT UNREACHABLE</span> ${live.lastError ? live.lastError : 'Falling back to Simulation Mode so no fabricated "live" data is shown.'}`;
  } else {
    note.innerHTML = `<span class="badge sched">SIMULATION MODE</span> No ENERGY_API_URL is configured on the server, so EcoSync is running on its built-in realistic simulator.`;
  }
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const body = {
    tariff: {
      peakStartHour: Number(document.getElementById('set-peak-start').value),
      peakEndHour: Number(document.getElementById('set-peak-end').value),
      peakRatePerKwh: Number(document.getElementById('set-peak-rate').value),
      normalRatePerKwh: Number(document.getElementById('set-normal-rate').value),
      offPeakRatePerKwh: Number(document.getElementById('set-offpeak-rate').value),
      solarExportRatePerKwh: Number(document.getElementById('set-export-rate').value),
    },
    gridEmissionFactorKgPerKwh: Number(document.getElementById('set-co2').value),
    buildingProfileScale: Number(document.getElementById('set-scale').value),
    simulationSpeedMultiplier: Math.max(0.1, Number(document.getElementById('set-sim-speed').value) || 1),
    battery: {
      capacityKwh: Number(document.getElementById('set-batt-cap').value),
      minReservePct: Number(document.getElementById('set-batt-reserve').value),
      maxRateKw: Number(document.getElementById('set-batt-rate').value),
    },
  };
  const result = await postJSON('/settings', body);
  const note = document.getElementById('settings-saved-note');
  if (!result) {
    note.textContent = 'Could not save — check connection ✕';
    note.style.display = 'inline-block';
    setTimeout(() => { note.style.display = 'none'; note.textContent = 'Saved ✓'; }, 2500);
    return;
  }
  note.style.display = 'inline-block';
  setTimeout(() => { note.style.display = 'none'; }, 2000);
});

// ---------- Polling ----------
function refreshActivePanel(name) {
  ({
    overview: refreshOverview, forecast: refreshForecast, loads: refreshLoads,
    demo: refreshDemo, battery: refreshBattery, alerts: refreshAlerts,
    devices: refreshDevices, impact: refreshImpact, settings: refreshSettings,
  }[name] || (() => {}))();
}

refreshOverview();
setInterval(() => {
  const active = document.querySelector('.navbtn.active').dataset.panel;
  refreshActivePanel(active);
}, 3000);
