# Auto-configured Solar Forecast — Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each beta site's home location, detect its solar panel layout from its production history on a schedule, and serve the layout plus recent hourly solar actuals to the iOS app.

**Architecture:** A pure TypeScript detector in `src/lib/solar-layout/` (sun geometry → clear-sky → plane-of-array model → clear-interval selection and shading → grid search + refinement → plane count by day-blocked CV → bootstrap confidence) ported from the Python reference. A `SiteSolarLayout` table holds location and the latest result. A pg_cron-driven route detects due sites within the 60 s Hobby limit; two mobile routes accept the location and return the layout and actuals. Everything is gated by the `solar-forecast-beta` user role. The iOS side is a separate plan.

**Tech Stack:** Next.js App Router route handlers (Node runtime), TypeScript, `pg` via `@/lib/db`, `@js-temporal/polyfill`, Vitest, Supabase pg_cron + pg_net. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-auto-solar-forecast-design.md`

## Global Constraints

- All work in `cmd/next-app`; run commands from there. `npm run lint`, `npm run build` and `npm test -- --run` must pass before the branch is finished.
- Location is stored rounded to 2 decimals (~1 km). Never store or log a finer fix.
- Minimum history for detection: 6 weeks (42 local days) of day records with solar data.
- Confidence is `low` when fewer than 15 clear days were found, or any chosen plane sits at the tilt limit (50°), or the bootstrap 90% azimuth range of the largest plane is wider than 60°, or the location fails the solar-noon check (longitude differs by more than 1.5°).
- Model constants (from the reference): derate 0.85 (range 0.80–0.90); azimuth grid 0–350° step 10; tilt grid 0–50° step 5; max tilt 50°; albedo 0.2; Linke turbidity 3.0 (climatological, replaces pvlib's lookup table); temperature prior −10% at 1000 W/m² plus ambient ±8 °C seasonal / ±4 °C daily at −0.37 %/°C.
- Samples are Wh per 5 minutes labelled at interval start; kW = Wh × 12 / 1000; evaluate the sun at the interval midpoint (+2.5 min).
- Azimuth is stored and served in compass degrees (0 = N, 90 = E, 180 = S, 270 = W). Forecast.Solar conversion happens on the phone.
- Beta role string: `solar-forecast-beta`. Users without it: the cron skips their sites and the mobile routes answer `{ enabled: false }`.
- Survey/research sites' data is never committed. CI uses synthetic fixtures only.
- Parity bar vs the Python reference (local-only): same confidence level and plane count for `high`/`medium` sites, and backtest calibrated hourly error within 1 percentage point per site.
- Cron routes: `maxDuration = 60`, Bearer `CRON_SECRET`, `withIoDeadline`, `observeRoute`, `logEvent`; stop starting new sites at 35 s; hard I/O deadline 50 s.
- New mobile routes follow `src/app/api/mobile/load-planning-context/route.ts`: `withRequestContext`, `verifySiteAccess`, `Cache-Control: private, no-store, max-age=0`.

## Review Focus

- **A site whose history is mostly night or mostly zero (dead inverter, new install with PTO gap)** → detection reports `not-enough-history`, never a fitted layout. Test in Task 7.
- **Fall-back DST day (25 local hours) and spring-forward day inside the history** → day grouping uses the site's IANA zone; no duplicated or dropped days. Test in Task 5.
- **A layout pointing north or straddling 0°/360° (e.g. 350° and 10°)** → azimuth averaging and bootstrap ranges wrap correctly instead of reporting 180°. Test in Task 6.
- **Phone posts a location for a site belonging to another user, or out-of-range / non-numeric coordinates** → 401 / 400, nothing stored. Test in Task 9.
- **A detection run that throws or times out mid-site** → previous result kept, `attempted_at` set so the site is not retried for 24 h, next site still processed. Test in Task 8.

---

### Task 1: Reference detector and storage

Commits the Python reference (code only), adds the table and its repository.

**Files:**
- Create: `scripts/solar-layout-reference/detector.py` (copy of `/Users/kevm/github/pwusage/.forecast-compare/detector/detector.py`, code only, no data or results)
- Create: `scripts/solar-layout-reference/README.md` (what it is, that it is the parity reference, how to run it locally with a Python 3.12 venv + pvlib; that research data is not in the repo)
- Create: `db-migrations/<timestamp>_site_solar_layout.sql` (use `npx tsx scripts/create-migration.ts site_solar_layout` or the timestamp convention)
- Create: `src/lib/solar-layout-repo.ts`
- Test: `src/lib/solar-layout-repo.test.ts`
- Modify: `CLAUDE.md` (Key Data Models: add `SiteSolarLayout`)

**Interfaces:**
- Produces:
  - Table `"SiteSolarLayout"`: `site_id text PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE`, `latitude numeric(5,2)`, `longitude numeric(6,2)`, `location_set_at timestamptz`, `result jsonb` (a `SolarLayoutResult`, see Task 7), `status text CHECK (status IN ('pending','detected','not-enough-history','low-confidence','failed'))`, `detected_at timestamptz`, `attempted_at timestamptz`, `detector_version smallint`. Idempotent (`IF NOT EXISTS`).
  - `class SolarLayoutRepo` with:
    - `setLocation(siteId: string, latitude: number, longitude: number): Promise<void>` — rounds to 2 decimals, sets `status='pending'`, clears `attempted_at`.
    - `get(siteId: string): Promise<SiteSolarLayoutRow | null>` where `SiteSolarLayoutRow = { siteId: string; latitude: number | null; longitude: number | null; locationSetAt: Date | null; result: SolarLayoutResult | null; status: 'pending' | 'detected' | 'not-enough-history' | 'low-confidence' | 'failed'; detectedAt: Date | null; attemptedAt: Date | null; detectorVersion: number | null }` (numeric columns parsed to numbers). `SolarLayoutResult` is defined in Task 7; until then type `result` as `unknown` and narrow in Task 7.
    - `saveResult(siteId: string, result: SolarLayoutResult, detectorVersion: number): Promise<void>` — sets `status` from `result.status`, `detected_at` and `attempted_at` to now. A `failed` status keeps the previous `result`.
    - `recordFailure(siteId: string): Promise<void>` — sets `attempted_at = now()` only.
    - `listDue(limit: number, now: Date): Promise<DueSite[]>` where `DueSite = { siteId: string; timezone: string; latitude: number; longitude: number }`: sites whose owner has role `solar-forecast-beta`, with a location, where (`detected_at IS NULL` or `detected_at < now - 30 days`) and (`attempted_at IS NULL` or `attempted_at < now - 24 h`), ordered `detected_at NULLS FIRST, attempted_at NULLS FIRST`.

- [ ] **Step 1: Write failing repo tests** (use the repo's existing DB test pattern; check `src/lib/site-repo.test.ts` for how a pool is mocked or a test DB is used, and follow it)
  - `setLocation rounds to two decimals` — `setLocation('s1', 43.39321, -87.87154)` then `get('s1')` → `latitude 43.39`, `longitude -87.87`, `status 'pending'`.
  - `listDue skips sites without the beta role, without a location, detected in the last 30 days, or attempted in the last 24 hours`.
  - `saveResult with failed status keeps the previous result`.
- [ ] **Step 2:** Run `npm test -- --run src/lib/solar-layout-repo.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Write the migration and `SolarLayoutRepo`.
- [ ] **Step 4:** Run the tests → PASS. Apply the migration to a local DB if the test pattern needs it.
- [ ] **Step 5: Commit** — `feat(solar): add SiteSolarLayout storage and reference detector`

---

### Task 2: Beta flag

**Files:**
- Create: `src/lib/solar-forecast-beta.ts`
- Modify: `src/lib/auth-checks.ts` (export `getCurrentRoles`)
- Test: `src/lib/solar-forecast-beta.test.ts`

**Interfaces:**
- Produces: `SOLAR_FORECAST_BETA_ROLE = 'solar-forecast-beta'`; `hasSolarForecastBeta(roles: readonly string[]): boolean`; `getCurrentRoles: () => Promise<string[]>` (React `cache`, same auth state source as `isUserAdmin`; `[]` when signed out).

- [ ] **Step 1: Failing test** — `hasSolarForecastBeta(['solar-forecast-beta'])` → true; `(['admin'])` → false; `([])` → false.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Admins do **not** get the beta implicitly.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(solar): add solar-forecast-beta role check`

---

### Task 3: Sun geometry and clear sky

**Files:**
- Create: `src/lib/solar-layout/sun.ts`
- Test: `src/lib/solar-layout/sun.test.ts`

**Interfaces:**
- Produces:
  - `type SunSample = { apparentZenith: number; elevation: number; azimuth: number; dniExtra: number; ghi: number; dni: number; dhi: number }` (degrees, W/m²)
  - `sunAt(time: Date, latitude: number, longitude: number): SunSample` — solar position (NREL SPA or the NOAA algorithm with refraction; must hit the tolerances below), extraterrestrial DNI (Spencer), relative airmass (Kasten–Young) at sea-level pressure, Ineichen-Perez clear sky with Linke turbidity 3.0, altitude 0.

- [ ] **Step 1: Failing tests** with values computed by pvlib 0.16.1 at lat 43.39, lon −87.87:

| UTC time | apparentZenith | azimuth | dniExtra | ghi | dni | dhi |
|---|---|---|---|---|---|---|
| 2026-06-21T17:30:00Z | 20.520 | 164.567 | 1321.62 | 949.18 | 901.95 | 104.45 |
| 2026-12-21T15:00:00Z | 77.274 | 140.647 | 1412.71 | 161.04 | 523.93 | 45.62 |
| 2026-03-20T22:00:00Z | 68.770 | 248.691 | 1377.69 | 314.88 | 695.21 | 63.13 |

  Tolerances: zenith and azimuth ±0.05°; dniExtra ±1 W/m²; ghi/dni/dhi ±2%. Also `elevation < 0` and `ghi === 0` at 2026-06-21T07:00:00Z.
- [ ] **Step 2:** Run `npm test -- --run src/lib/solar-layout/sun.test.ts` → FAIL.
- [ ] **Step 3:** Implement `sunAt`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(solar): sun position and clear-sky irradiance`

---

### Task 4: Plane-of-array model and synthetic fixtures

**Files:**
- Create: `src/lib/solar-layout/poa.ts`
- Create: `src/lib/solar-layout/synthetic.ts` (test-only helper, imported only by tests)
- Test: `src/lib/solar-layout/poa.test.ts`

**Interfaces:**
- Consumes: `sunAt`, `SunSample` (Task 3).
- Produces:
  - `type Plane = { azimuth: number; tilt: number; effectiveKw: number }`
  - `poaEffective(sun: SunSample, azimuth: number, tilt: number): number` — Hay-Davies sky diffuse + ground diffuse (albedo 0.2) + beam × physical IAM (n = 1.526, K = 4, L = 0.002) + diffuse IAM as in the reference `_diffuse_iam`, then the temperature prior (reference `ambient_factor` and `TEMP_C`).
  - `modelKw(sun: SunSample, planes: Plane[], clipKw: number | null): number` — Σ effectiveKw × poaEffective / 1000, then the reference's smooth cap (`_softmin`) at `clipKw`.
  - `syntheticSeries(opts: { latitude: number; longitude: number; timeZone: string; start: string; days: number; planes: Plane[]; clipKw?: number; cloudyFraction: number; shade?: { azimuthFrom: number; azimuthTo: number; belowElevation: number }[]; seed: number }): { timestamp: Date; solarWh: number }[]` — 5-minute samples; cloudy days scale output by a seeded random 0.1–0.7 with intraday noise; shaded sun positions get 20% of output; values in Wh per 5 min.

- [ ] **Step 1: Failing tests**
  - pvlib Hay-Davies values (before IAM and temperature) for tilt 20°, azimuth 180° at the Task 3 times: total POA 1011.69 / 308.14 / 389.47 W/m² ±2% — expose `poaComponents(sun, azimuth, tilt)` returning `{ direct, skyDiffuse, groundDiffuse }` for this test.
  - physical IAM at AOI 0 / 45 / 60 / 80° → 1.0 / 0.988 / 0.946 / 0.6341 (±0.001).
  - `modelKw` with `clipKw = 5` never exceeds 5.05.
  - `syntheticSeries` is deterministic for a seed and has 288 samples per normal local day.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(solar): plane-of-array model and synthetic fixtures`

---

### Task 5: Clear-interval selection, clipping and shading

**Files:**
- Create: `src/lib/solar-layout/selection.ts`
- Test: `src/lib/solar-layout/selection.test.ts`

**Interfaces:**
- Consumes: `SunSample`, `modelKw`, `syntheticSeries`.
- Produces (ports of the reference functions named in brackets):
  - `type Series = { time: Date; kw: number; sun: SunSample; localDay: string }[]` (localDay = `YYYY-MM-DD` in the site zone).
  - `toSeries(samples: { timestamp: Date; solarWh: number }[], latitude: number, longitude: number, timeZone: string): Series` — midpoint sun, night-baseline removal [`detect` lines 429–432].
  - `detectClip(series: Series): { limitKw: number; intervals: number; days: number } | null` [`detect_clip`].
  - `envelopeClear(series: Series, peakKw: number): boolean[]` [`envelope_clear` + `smoothness`].
  - `flatRuns(kw: number[], model: number[], clipKw: number | null): boolean[]` [`flat_runs`].
  - `class ShadeMask { shaded(azimuth: number, elevation: number): boolean; summary(): { azimuthFrom: number; azimuthTo: number; belowElevation: number }[] }` and `learnShade(...)` [`learn_shade`, threshold 0.85, 10° azimuth bins, monotone in elevation].

- [ ] **Step 1: Failing tests** (synthetic, single plane 180°/25°/6 kW at lat 35, lon −118, `America/Los_Angeles`, 120 days from 2026-03-01, cloudyFraction 0.4, seed 1):
  - `envelopeClear` marks ≥ 85% of the generator's clear-day daylight samples and ≤ 5% of cloudy-day samples.
  - With `clipKw: 4.5`, `detectClip` returns `limitKw` within 2% of 4.5; without clipping it returns `null`.
  - With shade `{ azimuthFrom: 240, azimuthTo: 290, belowElevation: 20 }`, `learnShade(...).shaded(260, 10)` is true and `.shaded(180, 10)` is false.
  - A series spanning 2026-11-01 (fall-back) yields one `localDay` `2026-11-01` with 300 samples, and 2026-03-08 yields 276.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(solar): clear-sky selection, clip and shade detection`

---

### Task 6: Plane fitting

**Files:**
- Create: `src/lib/solar-layout/fit.ts`
- Test: `src/lib/solar-layout/fit.test.ts`

**Interfaces:**
- Consumes: `Plane`, `poaEffective`, `modelKw`, `Series`.
- Produces:
  - `fitPlanes(series: Series, selected: boolean[], clipKw: number | null, planeCount: 1 | 2 | 3, opts?: { starts?: number }): { planes: Plane[]; rmseKw: number; candidates: Plane[][] }` — exhaustive azimuth × tilt grid with non-negative linear size solve via the Gram matrix [`build_grid`, `grid_search`], then robust (soft-L1) continuous refinement of the best `starts` candidates [`refine`, `fit_n`]. For 3 planes, search only combinations that extend the top 20 two-plane grid results (keeps the run inside the time budget).
  - `choosePlaneCount(series, selected, clipKw, rng): { count: 1 | 2 | 3; cvNrmse: Record<1|2|3, number> }` — 5-fold CV blocked by `localDay` [`choose_n`]: accept an extra plane only if held-out nRMSE improves by more than 8%, it is ≥ 8% of total size, its orientation differs from the others by ≥ 30°, and it is not a plane under 15% of total size at the tilt limit.
  - `bootstrap(series, selected, clipKw, best: Plane[], rounds: number, rng): Plane[][]` — resample days with replacement and refine from `best` [`align`, `unwrap_rel`].
  - `azimuthRange90(samples: number[], reference: number): [number, number]` — 5th/95th percentiles after unwrapping around `reference`, returned mod 360.
  - `seededRng(seed: number): () => number` (mulberry32 or similar).

- [ ] **Step 1: Failing tests** (synthetic, 1 year from 2025-11-01, lat 43.4, lon −87.9, `America/Chicago`, cloudyFraction 0.5, seed 7):
  - East/west 90°/20°/5 kW + 270°/20°/4 kW → `choosePlaneCount` picks 2; fitted azimuths within 15° of 90 and 270, tilts within 6°, total effectiveKw within 10%.
  - Single 180°/30°/6 kW → picks 1; azimuth within 5°, tilt within 4°.
  - Single 355°/10° (north-ish, 2 kW) → fitted azimuth reported in [340, 360) ∪ [0, 10); `azimuthRange90([350, 355, 5, 10], 355)` → `[350, 10]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Note wall time of the east/west test in the commit message.
- [ ] **Step 5: Commit** — `feat(solar): plane grid search, refinement and plane-count CV`

---

### Task 7: Detection result and confidence

**Files:**
- Create: `src/lib/solar-layout/detect.ts`
- Test: `src/lib/solar-layout/detect.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  - `SOLAR_LAYOUT_DETECTOR_VERSION = 1`
  - `type SolarLayoutResult = { status: 'detected' | 'low-confidence' | 'not-enough-history' | 'failed'; confidence: 'high' | 'medium' | 'low' | null; reasons: string[]; planes: { azimuth: number; tilt: number; dcKwp: number; effectiveKw: number; azimuthRange90: [number, number]; tiltRange90: [number, number] }[]; acClipKw: number | null; historyDays: number; clearDays: number; firstDay: string | null; lastDay: string | null; shading: { azimuthFrom: number; azimuthTo: number; belowElevation: number }[] }`
  - `detectSolarLayout(input: { samples: { timestamp: Date; solarWh: number }[]; latitude: number; longitude: number; timeZone: string; deadline?: number; seed?: number; bootstrapRounds?: number }): SolarLayoutResult` — orchestration as reference `detect` (two shade-learning passes, clear days ≥ 60% selected, contributing days ≥ 25%), `dcKwp = effectiveKw / 0.85`, default `bootstrapRounds = 20`. Throws `DetectionDeadlineError` if `Date.now() > deadline` between stages.
  - Confidence: `low` per Global Constraints (reasons `few-clear-days`, `plane-at-tilt-limit`, `azimuth-uncertain`, `location-mismatch`); `high` when ≥ 40 clear days, ≥ 180 history days and the largest plane's azimuth range is ≤ 30°; else `medium`. Status `low-confidence` when confidence is `low`.
  - Solar-noon check: for each clear day, time of the production centroid vs. the model's; median offset converted to longitude (4 min per degree); mismatch if > 1.5°.
  - `not-enough-history` when fewer than 42 local days have any production above 0.

- [ ] **Step 1: Failing tests**
  - 30 days of synthetic data → `not-enough-history`, empty `planes`.
  - 1 year of synthetic data whose samples are all 0 → `not-enough-history`.
  - East/west year from Task 6 → `detected`, 2 planes, `high`.
  - Same data with `longitude` passed 3° off → `low-confidence`, reasons include `location-mismatch`.
  - Heavy shade (all sun below 35° shaded), 100 days, cloudyFraction 0.8 → `low-confidence`.
  - `deadline: Date.now() - 1` → throws `DetectionDeadlineError`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(solar): detect solar layout with confidence`

---

### Task 8: Parity check and the detection cron

**Files:**
- Create: `scripts/solar-layout-parity.ts` (local-only: `npx tsx scripts/solar-layout-parity.ts --dir <folder>` reads `site-*.csv` files with columns `timestamp,solar_wh` plus an `inputs.json` of timezone/lat/lon, runs `detectSolarLayout` on each and writes `<site>.ts.json` next to them. The README in `scripts/solar-layout-reference/` gives the one-line pandas command that turns the research parquet exports into those CSVs, outside the repo.)
- Create: `src/lib/solar-layout/run-detections.ts`
- Create: `src/app/api/cron/detect-solar-layouts/route.ts`
- Create: `db-migrations/<timestamp>_detect_solar_layouts_cron.sql`
- Test: `src/lib/solar-layout/run-detections.test.ts`

**Interfaces:**
- Consumes: `SolarLayoutRepo` (Task 1), `detectSolarLayout` (Task 7), `createEnergyRepo(timezone).getRawEnergyData(siteId, start, end)` (existing; rows have `timestamp` and `solar_power` in Wh per 5 min).
- Produces: `runDueDetections(opts: { now: Date; budgetMs: number; repo: SolarLayoutRepo; loadSamples: (siteId: string, timeZone: string, start: Date, end: Date) => Promise<{ timestamp: Date; solarWh: number }[]> }): Promise<{ sites: { siteId: string; status: string; ms: number }[]; stopped: boolean }>` — takes up to 5 due sites, loads the last 365 days, runs detection with a deadline, saves results; on throw calls `recordFailure` and continues; stops starting new sites after `budgetMs`.

- [ ] **Step 1: Parity (local, before any cron work).** Run the reference on the five research sites, export each site's samples to CSV, run `npx tsx scripts/solar-layout-parity.ts`, and compare against the parity bar in Global Constraints using `.forecast-compare/backtest.py`. Record per-site numbers and the max per-site runtime in the PR description. If Harrison's full year exceeds 40 s, reduce work (fewer refinement starts, coarser grid then refine, `bootstrapRounds` 10) until it fits, and re-check parity. Do not commit any research data or results.
- [ ] **Step 2: Failing tests** for `runDueDetections` with a fake repo and loader:
  - Saves a result for each due site.
  - A loader that throws for site 1 → `recordFailure('s1')`, site 2 still processed.
  - With `budgetMs: 0` → no sites started, `stopped: true`.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement `runDueDetections` and the route (pattern of `src/app/api/cron/heal-gaps/route.ts`, event names `cron.detect-solar-layouts.*`, budget 35 s, deadline 50 s).
- [ ] **Step 5:** Migration: `cron.schedule('detect-solar-layouts-trigger', '23 */3 * * *', …)` with the URL derived from the `battery_restore_cron_target_url` Vault secret exactly as `20261017203000_heal_gaps_cron.sql` does, path `/api/cron/detect-solar-layouts`. Header comment states the measured egress per site (Step 6).
- [ ] **Step 6:** Measure Supabase egress for one Harrison run on the Dev DB (socket byte count, as earlier cron PRs did) and put the number in the migration comment.
- [ ] **Step 7:** Run tests → PASS. **Commit** — `feat(solar): scheduled solar layout detection`

---

### Task 9: Mobile location and layout routes

**Files:**
- Create: `src/app/api/mobile/solar-layout/route.ts` (GET layout, POST location)
- Create: `src/lib/solar-layout/mobile-contract.ts`
- Test: `src/app/api/mobile/solar-layout/route.test.ts`

**Interfaces:**
- Consumes: `SolarLayoutRepo`, `getCurrentRoles`, `hasSolarForecastBeta`, `verifySiteAccess`.
- Produces:
  - `GET /api/mobile/solar-layout?siteId=` →
    - not beta: `{ version: 1, enabled: false }`
    - beta: `{ version: 1, enabled: true, location: { latitude, longitude } | null, layout: { planes: { azimuth, tilt, dcKwp }[], acClipKw, confidence: 'high' | 'medium', detectedAt } | null, reason: 'needs-location' | 'pending' | 'not-enough-history' | 'low-confidence' | null }` — `layout` is non-null only for status `detected`.
  - `POST /api/mobile/solar-layout` body `{ siteId: string, latitude: number, longitude: number }` → 204; beta-only (403 otherwise); 400 unless finite, |lat| ≤ 90, |lon| ≤ 180; stores rounded via `setLocation`.
  - `toMobileSolarLayout(row: SiteSolarLayoutRow | null): MobileSolarLayout` in `mobile-contract.ts`.

- [ ] **Step 1: Failing tests**
  - GET for a non-beta user → `{ version: 1, enabled: false }`.
  - GET beta, no row → `reason: 'needs-location'`, `layout: null`.
  - GET beta, `status 'low-confidence'` → `reason: 'low-confidence'`, `layout: null`.
  - GET beta, detected → planes in compass degrees with `dcKwp`, `confidence 'high'`.
  - POST for a site the user cannot access → 401, nothing stored.
  - POST `{ latitude: 'abc' }` or `latitude: 91` → 400.
  - POST valid `43.39321, -87.87154` → 204 and the repo received `43.39, -87.87`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(solar): mobile solar layout and location routes`

---

### Task 10: Recent hourly solar actuals for the phone's correction

**Files:**
- Create: `src/app/api/mobile/solar-actuals/route.ts`
- Create: `src/lib/solar-layout/hourly-actuals.ts`
- Test: `src/lib/solar-layout/hourly-actuals.test.ts`

**Interfaces:**
- Consumes: `createEnergyRepo(timezone).getRawEnergyData`.
- Produces:
  - `hourlySolarWh(rows: { timestamp: Date; solar_power: number }[]): { hourStart: string; wh: number; complete: boolean }[]` — UTC hour buckets by interval start; `complete` when all 12 samples exist.
  - `GET /api/mobile/solar-actuals?siteId=` (beta + `verifySiteAccess`) → `{ version: 1, asOf, hours: [...] }` for the 14 full local days before today plus today so far.

- [ ] **Step 1: Failing tests** — 12 samples of 100 Wh in one hour → `{ wh: 1200, complete: true }`; 11 samples → `complete: false`; a sample labelled `10:55` belongs to the `10:00` hour.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (route follows Task 9's auth and headers).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `feat(solar): recent hourly solar actuals for forecast correction`

---

### Task 11: Privacy page and wrap-up

**Files:**
- Modify: `src/app/privacy/page.tsx`
- Modify: `TODO.md` (iOS plan pending; provider decision rule and the forward capture still running)

- [ ] **Step 1:** Add to the privacy page, in its existing voice: PWUsage stores your home's approximate location (rounded to about 1 km) to work out how your solar panels face, and the app sends that rounded location and your panels' direction, tilt and size to Forecast.Solar to get a solar forecast. Only for users in the solar forecast beta.
- [ ] **Step 2:** Run `npm run lint && npm run build && npm test -- --run` → all pass.
- [ ] **Step 3: Commit** — `docs(solar): privacy notice for automatic solar forecast`
