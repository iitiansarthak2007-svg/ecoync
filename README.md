# EcoSync — SIH26200 working prototype

A genuinely working prototype: a real Node.js backend running a deterministic
energy-balance simulation, a rule-based optimization engine, a heuristic
forecaster, a real scheduling algorithm, and anomaly detection — served to a
live-updating dashboard. No random numbers pretending to be intelligence, no
buttons that just show `alert()`, and no fake "Live" label on simulated data.

## 1. Install & run locally

Requires only **Node.js 18+**. No `npm install` is needed to run the demo —
this build has **zero external dependencies**, backend and frontend, so it
runs completely offline in a room with no reliable Wi-Fi. Charts are drawn
by `public/minichart.js`, a small canvas renderer we wrote ourselves — there
is no CDN call for anything the app needs to function (only the optional
Google Fonts `@import` in `styles.css`, which degrades to a plain system
font if there's no internet — nothing breaks).

```bash
cd ecosync-prototype
node server.js
```

Then open **http://localhost:4600**.

To change the port:

```bash
PORT=5000 node server.js
```

## 2. Environment variables

Copy `.env.example` to `.env` and edit it, or set real environment variables
on your host. The server has a tiny built-in loader for `.env` — no `dotenv`
package needed.

| Variable | Required? | Purpose |
|---|---|---|
| `PORT` | No (default `4600`) | Port the HTTP server listens on. |
| `ENERGY_API_URL` | No | If set, EcoSync polls this URL for real readings (LIVE MODE). If unset, EcoSync runs in SIMULATION MODE. |
| `ENERGY_API_KEY` | No | Sent as `Authorization: Bearer <key>` to `ENERGY_API_URL`. Never exposed to the frontend. |

**Never commit a real `.env` file.** `.gitignore` already excludes it.

## 3. Simulation Mode vs. Live Mode — how it actually works

This is the part most hackathon prototypes fake. Here's exactly what EcoSync
does:

- **No `ENERGY_API_URL` set →** EcoSync runs `engine/profiles.js`, a
  deterministic solar/demand model (same hour of day always produces the
  same base reading, so a judge can be told exactly why a number is what it
  is — not `Math.random()`). The dashboard's **DATA SOURCE** pill reads
  `● DEMO SIMULATION`.
- **`ENERGY_API_URL` set and reachable →** `engine/liveProvider.js` polls it
  every ~8 seconds in the background, in parallel with the tick loop, and
  its `solarKw`/`demandKw`/`batterySoc` values feed directly into the same
  engine that would otherwise use the simulator. The pill reads `● LIVE API`.
- **`ENERGY_API_URL` set but unreachable, times out, or returns a malformed
  response →** EcoSync automatically falls back to Simulation Mode within
  one poll cycle and the pill reads `SIMULATION (live API configured but
  unreachable — auto fallback)`. The real error is visible at
  `GET /api/health` (`liveApi.lastError`). It never shows fabricated numbers
  labelled as live.

Expected JSON shape from your real API (edit the parsing in
`engine/liveProvider.js` if your provider's shape differs):

```json
{ "solarKw": 3.2, "demandKw": 2.1, "batterySoc": 61 }
```

### Try it yourself

```bash
# Terminal 1 — a fake "real" energy API for testing
node -e "
require('http').createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({solarKw:5.5, demandKw:2.2, batterySoc:77}));
}).listen(9999);
"

# Terminal 2
ENERGY_API_URL=http://localhost:9999 node server.js
```

Open the dashboard — within ~8 seconds the DATA SOURCE pill switches to
`LIVE API` and the numbers match the fake server. Kill Terminal 1 and watch
it fall back to Simulation Mode automatically.

## 4. Live vs. demo clock

- **Ambient mode** (default): the simulation clock runs continuously,
  compressed so a full 24-hour cycle passes in about 8 real minutes — enough
  to see solar rise and fall without waiting for a literal day.
- **Demo mode** (Demo Mode tab → *Start demo*): resets to 06:00 and plays a
  full day at a faster, fixed pace with Start / Pause / Reset controls, for a
  scripted 3–5 minute judge walkthrough. This is "SIH Demo Mode" — everything
  (dashboard, charts, forecast, optimization, alerts) runs live from this,
  no hardware needed.
- **Scenario simulator**: overrides live readings directly with slider
  values so you can manufacture a specific situation (e.g. push demand to
  9 kW with solar near zero) and watch the engine react and alerts fire
  instantly.

## 5. How forecasting works

`engine/forecast.js` produces the next 24 hourly points from:

1. the deterministic time-of-day solar/demand profile for that hour, blended
2. with a moving average of recent actual readings at that same hour-of-day
   (30% weight), which is why the forecast "learns" as more history accumulates.

Confidence is reported per point and decreases the further ahead the point
is (92% falling to ~52% at hour 24). This is **explicitly not a trained ML
model** — it's a transparent, explainable heuristic, and the UI says so
(`forecast-engine-label` in the Forecast tab) so nobody can accuse the team
of overclaiming "AI".

## 6. How optimization works

`engine/optimization.js` is a transparent rule-based decision engine (not a
black box, not ML): given current solar, demand, battery state of charge,
and availability flags, it picks one of `CHARGE BATTERY`, `EXPORT GRID`,
`USE SOLAR`, `DISCHARGE BATTERY`, `IMPORT GRID`, or `SHIFT LOAD`, and returns
a plain-English `reason` and `expectedImpact` alongside a 0–100 renewable
score. `engine/scheduler.js` separately runs a sliding-window search over the
forecast to find, for each flexible load (EV charging, water pump, laundry,
HVAC), the start time within its allowed window that captures the most solar
— this is what "Optimize schedule" on the Smart Loads tab actually computes.

## 7. Tariff, cost & CO₂ — all configurable, not hardcoded

Configure these from the **Settings** tab (saved to `data/settings.json`,
applied immediately, and used everywhere — nothing else in the codebase
hardcodes these numbers):

- Peak / normal / off-peak tariff rates and the peak hour window
- Solar export rate (₹/kWh sold back to the grid)
- Grid CO₂ emission factor (kg/kWh) — shown next to every CO₂ figure so the
  assumption is transparent, never presented as an invented statistic
- Battery capacity, minimum reserve %, max charge/discharge rate
- Building/load profile scale (models a bigger or smaller campus)

The dashboard shows: grid import cost, net cost (after solar export
revenue), a projected monthly cost extrapolated from the current rate,
potential savings vs. a naive no-EcoSync baseline, and solar savings
(renewable energy served × the tariff rate it displaced).

## 8. Data storage

`data/state.json` (a JSON file used as a lightweight database — no
extra install needed) is written every ~10 seconds and **reloaded on server
start**, so history, cumulative totals, battery state, alerts, and load
schedules survive both a browser refresh and a server restart.
`data/settings.json` persists your Settings-tab configuration the same way.

If you have npm/internet access before judging and want a real database,
swap `persistSnapshot`/`restoreSnapshot` in `server.js` for
`better-sqlite3` — that's the only place that touches storage, so the
`engine/` layer doesn't need to change at all.

## 9. API reference

All endpoints are real and backed by the engine above — none return
hardcoded numbers.

```
GET  /api/health          server status, uptime, current data-source mode, live-API status
GET  /api/dashboard        current readings, decision, cost/CO2/battery summary
GET  /api/energy           current reading + rolling history (used by the charts)
GET  /api/energy/current   alias: latest reading only
GET  /api/energy/history   alias: rolling history only
GET  /api/energy/generation  alias: solar-only history series
GET  /api/energy/consumption alias: demand-only history series
GET  /api/energy/battery   alias of /api/battery
GET  /api/battery          battery detail (capacity, SoC, reserve, rates, status)
GET  /api/forecast         next-24h solar & demand forecast + confidence
GET  /api/loads            smart loads + schedule state
GET  /api/alerts           anomaly alerts
GET  /api/devices          simulated device list (clearly labelled — no real hardware)
GET  /api/impact           with-EcoSync vs. without-EcoSync comparison
GET  /api/settings         current configurable settings
POST /api/settings         update settings (tariff, CO2 factor, battery specs, ...)
POST /api/optimize         recompute a decision (live, or a what-if preview)
POST /api/schedule         run the scheduler across all flexible loads
POST /api/simulation       scenario overrides, demo controls, manual override,
                           per-load force on/off
```

### Example requests

```bash
curl http://localhost:4600/api/health
# {"status":"ok","uptimeSeconds":42,"dataSourceMode":"DEMO SIMULATION", ...}

curl http://localhost:4600/api/dashboard
# {"solar":2.86,"demand":3.95,"batterySoC":54.7,"gridImport":0, ...}

curl -X POST http://localhost:4600/api/settings \
  -H "Content-Type: application/json" \
  -d '{"battery":{"capacityKwh":30},"gridEmissionFactorKgPerKwh":0.7}'

curl -X POST http://localhost:4600/api/simulation \
  -H "Content-Type: application/json" \
  -d '{"loadId":"pump","forcedStatus":"off"}'
```

## 10. What's real vs. what's simulated — please read this before your demo

| Claim | Status |
|---|---|
| Solar / demand / battery physics | **Real, deterministic simulation** when no live API is connected. Same hour of day always produces the same base reading (`engine/profiles.js`). Battery state of charge is tracked against an actual energy balance (charge/discharge kWh vs. capacity), not a random walk. |
| Live API mode | **Real integration**, not a stub: `engine/liveProvider.js` actually fetches, parses, times out, and falls back on failure. Off by default; on only if you set `ENERGY_API_URL`. |
| Optimization decisions | **Real rule-based engine** (`engine/optimization.js`), explicitly not a trained ML model. |
| Forecast | **Real heuristic**: time-of-day profile blended with a moving average of recent readings (`engine/forecast.js`). Not claimed as ML. |
| Scheduler | **Real algorithm**: sliding-window search over the forecast (`engine/scheduler.js`). |
| Anomaly detection | **Real comparison** against the expected profile for that hour — alerts fire only when a reading actually deviates. |
| Cost / tariff / CO₂ | **Computed from configurable settings** (`engine/settings.js`) — no numbers are hardcoded inline in routes or components. |
| Impact numbers (before/after) | **Computed from tracked energy flows** across the whole session (`engine/state.js`, `cumulative`). |
| IoT / MQTT hardware | **Not connected.** The Devices page says so explicitly ("SIMULATION MODE — no physical device connected"). Swapping in a real `MQTTDataProvider` is a natural next step (see below). |
| Database | **JSON file** (`data/state.json`, `data/settings.json`), reloaded on restart — a real but lightweight persistence layer. |

## 11. Deployment

This is a single Node process serving both the API and the static frontend
from one port — no separate frontend build step, no bundler, so "production
build" is just "the same command you ran locally."

**Any host that runs a long-lived Node process works** (Render, Railway,
Fly.io, a plain VPS, Replit, etc.):

1. Push the repo (`.env` stays out of git — see `.gitignore`).
2. Set the `ENERGY_API_URL` / `ENERGY_API_KEY` environment variables in the
   host's dashboard if you have a real API to connect (optional).
3. Start command: `node server.js`. Most hosts inject `PORT` automatically;
   the server already reads `process.env.PORT`.
4. Point the host's health check at `GET /api/health`.
5. The frontend calls the API via a relative path (`/api/...`), so there are
   no hardcoded `localhost` URLs anywhere in `public/` — it works unmodified
   behind any domain.

If you later split the frontend onto separate static hosting, the API
already sends permissive CORS headers, so it can be called cross-origin.

## 12. Error handling

- API request bodies are always parsed defensively (`readJSONBody` never
  throws into a route — a malformed body degrades to `{}`).
- Every route is wrapped so a thrown error becomes a `500` with a message,
  not a hung connection or an unhandled crash.
- Loss of the live API mid-poll doesn't crash anything — the poller catches
  its own errors, records `lastError`, and the engine keeps ticking on
  simulated values until the live source recovers.
- Unknown API routes return a `404` with `{ "error": "Unknown endpoint" }`
  rather than falling through to the static file server.
- A missing/corrupt `data/state.json` on startup is caught and logged; the
  server starts fresh instead of crashing.

## 13. Extending toward real hardware / a real database

The engine layer (`engine/*.js`) doesn't know or care where its inputs come
from — that's deliberate.

1. **MQTT**: write an `MQTTDataProvider` (same shape as
   `engine/liveProvider.js` — expose `getLiveReading()`) that subscribes to
   a topic like `ecosync/campus/main-meter` and feeds real readings into
   `engine/state.js` in place of, or alongside, the HTTP-based
   `liveProvider`.
2. **Database**: swap `data/state.json` for `better-sqlite3` — the
   read/write surface (`persistSnapshot` / `restoreSnapshot` in
   `server.js`) is two functions, so this is a contained change.
3. **Framework**: this can become an Express app with the exact same route
   table if you'd prefer Express's middleware ecosystem; the routing here is
   intentionally plain so it runs with zero setup today.

## 14. Known limitations (stated plainly, not hidden)

- No physical smart meter or MQTT broker is connected in this build — Live
  Mode is real code, but you need an actual external API to point it at.
- The "production build" is the same static files served locally — there's
  no separate optimized bundle step, by design, to keep the zero-dependency
  offline story intact. If you want minified/bundled assets, that's a
  reasonable next step but isn't done here.
- The forecast and optimizer are transparent heuristics, not trained models
  — intentional, and disclosed in the UI, but worth knowing before a judge
  asks "is this real AI?".
- `data/*.json` is fine for a single-instance hackathon demo; it is not a
  concurrent-safe database for multiple server instances.

## Team

- Project: EcoSync
- Problem Statement: SIH26200
- Theme: Renewable / Sustainable Energy
- Category: Software
- Team: ECOSYNC


## AI failover
The AI layer uses Groq first, then OpenRouter's free-model router if `OPENROUTER_API_KEY` is configured. If both external providers fail or are rate-limited, EcoSync automatically falls back to a deterministic, data-grounded local assistant. This prevents the dashboard from becoming unusable during a demo. `GET /api/ai/status` shows the active provider.


## AI failover

EcoSync now supports a multi-provider failover chain: Groq -> Gemini -> Cerebras -> SambaNova -> Mistral -> OpenRouter -> Hugging Face -> Cohere -> optional local Ollama -> deterministic local EcoSync fallback. Add whichever provider keys you have to `.env`; missing keys are skipped automatically. A provider that returns a rate-limit/error is temporarily cooled down so the next provider is tried.

No cloud provider is guaranteed to be unlimited. For truly quota-free inference, enable the local Ollama option and run the model on your own computer.

Check the active provider at `GET /api/ai/status`.


---

## EcoSync AI Copilot

The assistant is an agent, not a chatbot with a JSON blob attached. Every
question is answered in three stages:

1. **Plan** — decide which deterministic tools are needed. An LLM planner does
   this when a provider is configured; a keyword planner does the same job
   offline. The model sees no energy data at this stage, so it cannot invent any.
2. **Execute** — run those tools (`engine/aiTools.js`). This produces every
   number that will appear in the answer.
3. **Explain** — hand the tool *results* to the model and ask it to explain
   them. With no provider, a deterministic composer writes the answer from the
   same results.

### Why this split matters

Arithmetic, comparisons and data availability are decided by code. That makes
*"I don't have enough data to determine that"* a reachable, honest answer
rather than something the model has to be trusted to say. Ask
*"compare this week with last week"* and EcoSync will tell you it only keeps a
rolling buffer of the current simulated day — it will not fabricate a week.

### Data honesty

Every figure carries a `basis`, shown in the UI as a badge:

| Basis | Meaning |
|---|---|
| `observed` | Integrated from actual recorded readings |
| `projection` | Modelled across a full day/period — not a measurement |
| `modelled` | Derived from the configured campus model (no sub-metering) |
| `forecast` | Heuristic prediction with decaying confidence |

EcoSync has **no per-appliance sub-metering, no multi-day history and no
weather feed**. Appliance figures come from each load's rated power, duration
and schedule; weekly/monthly figures are the daily model multiplied out. All of
this is stated in the responses themselves.

### New modules

| File | Purpose |
|---|---|
| `engine/analytics.js` | Deterministic numeric core — day projection, appliances, base load, cost, energy score, period comparison |
| `engine/anomaly.js` | Structured findings with expected vs actual, difference, explanation, action, confidence |
| `engine/whatif.js` | Scenario simulator — re-runs the day model with one variable changed |
| `engine/report.js` | Daily / weekly / monthly / custom report assembly |
| `engine/memory.js` | Transparent, editable user preferences with a strict allow-list |
| `engine/aiTools.js` | 21-tool registry the planner selects from |
| `engine/aiAgent.js` | Plan → execute → explain orchestrator |
| `public/copilot.js` | Frontend: score strip, Insights Center, Reports, appliance analytics, what-if, AI memory |

### New endpoints

Deterministic (no AI key needed, work offline):

```
GET  /api/analytics/overview | appliances | cost | score | standby | history
GET  /api/anomalies
GET  /api/insights
GET  /api/report?period=daily|weekly|monthly|custom&days=N
POST /api/whatif              { type, ... }
GET  /api/memory
POST /api/memory              { <preference>: value }  |  { clear: true }
GET  /api/ai/tools
POST /api/ai/tool             { tool, args }
GET  /api/ai/health
```

Agent:

```
POST /api/ai/ask              { message, history }
POST /api/chat                (now routed through the agent; response shape preserved)
```

### Security

API keys are read from server environment variables only and never reach the
browser. `engine/memory.js` enforces a strict allow-list and rejects any key
matching `/key|token|secret|password|credential|auth|bearer|apikey/i`, so a
credential cannot be persisted even if something tries. `.gitignore` excludes
`.env`, `.env.*` (keeping `.env.example`), `node_modules/` and runtime state.
