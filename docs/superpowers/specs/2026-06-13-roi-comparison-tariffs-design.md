# ROI Comparison Plans as Reporting-Only Tariffs (foundation)

**Date:** 2026-06-13
**Status:** Design approved, pending spec review
**Branch context:** `feat/roi` — builds on the Phase 2 ROI report (`2026-06-13-roi-report-design.md`) and the opt-in history-indexing phase (`2026-06-13-roi-history-indexing-design.md`).

## Problem

The Phase 2 scenario matrix (system × Fixed/TOU) prices its **Fixed** column (cells A, C, E) from two scalar fields — `SiteRoiConfig.fixed_buy_rate` / `fixed_sell_rate`. That scalar is a single rate frozen for the entire life of the system, which is unrealistic the moment a utility rate changes (e.g. a real site whose flat rate went $0.16580 → $0.19342 across its history). It also can't express a no-battery household whose realistic alternative is a *TOU* plan rather than flat.

The deeper issue: the matrix has **two** rate sources that should be uniform but aren't —

| Rate source | Used by | Stored as | History support |
|---|---|---|---|
| Fixed baseline | cells A, C, E | `SiteRoiConfig` scalars | none |
| Actual TOU tariff | cells B, D, F | `Tariff` versions | none — versions aren't effective-dated; `Schedule` ignores the year |

`Tariff` versioning (`version`, `is_current`, `content_hash`) is append-only for non-destructive edits, **not** date-resolved: `getTariffsForSite` returns all versions and `Schedule.getTariffPeriodByComponents` matches only on month/day/hour/weekday, so once a site has two versions the matcher returns an arbitrary first-match. The full unification (date-resolved *pricing* for both sources) is large and touches core billing; it is **deferred** (see Follow-ons). This phase ships the **foundation** — including capturing effective dates for display — that the deferred pricing work builds on.

## Goal

Replace the fixed-baseline scalars with a first-class **comparison plan**: a `Tariff` flagged `reporting_only`, priced read-side, never metered. The fixed baseline becomes the degenerate (flat) case. A Fixed/TOU toggle in the editor lets the user define which kind of baseline they're comparing against, and the user can enter a **rate timeline** (multiple versions with effective dates) that the UI labels and orders. Pricing still uses a single current rate this phase; the captured dates become real pricing in F1/F2.

## Scope cut (decided in brainstorming)

- **In:** the `reporting_only` flag + exclusion plumbing; the comparison-tariff editor with a Fixed/TOU toggle; read-side pricing of the Fixed column from the reporting-only Fixed tariff at a **single current rate**; an **`effective_from` date captured per tariff version, used for display/ordering only** (the editor lets the user enter a rate timeline; the UI labels and orders versions by date).
- **Display, not priced (this phase):** captured `effective_from` dates are **not** wired into pricing — all history is priced at the current (latest) version's rate, exactly as today. To avoid implying accuracy we don't deliver, the UI states plainly that historical rates are captured but **not yet applied** (pricing uses the current rate). So the originating $0.16580→$0.19342 overstatement is **not** corrected this phase.
- **Deferred to F1:** applying the captured `effective_from` to **comparison-column pricing** (cells A/C/E) — a read-side resolver that prices each rollup row at the comparison rate in effect on its date. Cheap (no re-rollup); this is what finally corrects the fixed-column history and turns the displayed dates into real pricing.
- **Deferred to F2:** the **metered** tariff's historical correction (cell F) — metered `Schedule` date-resolution + re-rollup of the snapshotted rates.
- **Deferred to 2b:** the toggle's **independent-TOU** branch — an arbitrary TOU comparison plan with different windows needs the plan-agnostic hourly profile to re-bucket; the period-keyed `EnergyRollup` can't. Until 2b, the TOU branch can only reuse the actual metered tariff as the baseline (which the matrix already does).
- **No data migration.** Existing `SiteRoiConfig.fixed_buy_rate` / `fixed_sell_rate` values are **not** ported. The fixed baseline starts empty; the user re-enters it once through the new editor. Those two columns are left in place as **deprecated/unused** (no migration spent dropping them).

## What a flat tariff is (precisely)

A Fixed comparison plan is the standard three-level chain, not a shortcut below it — `getTariffPeriod` returns `{tariff, season, schedule}` and a season with no schedules is skipped (`schedule.ts:92`):

- **1 `Tariff`** (`reporting_only = true`)
- **1 `TariffSeason`** spanning the whole year: `from_month=1, from_day=1, to_month=12, to_day=31`, carrying `buy_rate` + `sell_rate`.
- **1 `TariffSchedule`** covering all days/all hours.

Rate may live on the season or the schedule; `resolveRates` takes the schedule rate and falls back to the season's (`battery-provenance/rates.ts`). "Sell stays flat" lives naturally as the single schedule's sell rate.

### The day-of-week gotcha (must be pinned by a test)

`matchHourOfDay` and `matchDayOfWeek` treat all-null bounds **oppositely** (`schedule.ts`):

| Window | both bounds `null` | all-day/all-week value to write |
|---|---|---|
| Hours (`matchHourOfDay`) | returns **true** (matches all) | `from_hour=null, to_hour=null` ok |
| Day-of-week (`matchDayOfWeek`) | returns **false** (matches *nothing*) | **must** set `from_day_of_week=0, to_day_of_week=6` |

So a flat schedule minted with null day-of-week bounds matches zero days and the whole tariff resolves to `null`. The editor/mint path **must** write `from_day_of_week=0, to_day_of_week=6` (hours may stay null or `0`/`24`).

## Data model

### `Tariff` — add two columns (one migration)

```
reporting_only  boolean  NOT NULL DEFAULT false
effective_from  date     NULL     -- when this version's rates took effect
```

- `reporting_only = true` ⇒ a comparison plan: excluded everywhere the metered tariff is assumed. Default `false` keeps every existing tariff metered (behavior-neutral migration). A reporting-only tariff keeps `is_current = true` as "the current comparison plan" and has its own `name` (e.g. `"ROI Fixed baseline"`), so it never collides with the metered `tariff_current_uidx (site_id, name) WHERE is_current`.
- `effective_from` is captured per **`Tariff` version** — the grain at which a whole rate plan changes (not per TOU window). **This phase uses it for display/ordering only**; F1/F2 add the date-resolution that turns it into pricing. `NULL` = undated (legacy / "since the beginning"), which is also the F1/F2 fallback, so the column is behavior-neutral on migration. A version's effective **range is derived** — it runs until the next version's `effective_from`; the latest is "present." No explicit `to` column, which would invite drift/gaps.

### `SiteRoiConfig` — unchanged schema

Keeps investment metadata (costs, install dates). `fixed_buy_rate` / `fixed_sell_rate` become **deprecated/unused**; no migration.

## Exclusion plumbing (the real risk surface)

A reporting-only tariff must never leak into metered pricing. The audit:

- **Metered `Schedule`:** every call site that builds the *metered* `Schedule` from `getTariffsForSite` filters `reporting_only = false`. Otherwise `getTariffPeriod` for the real bill / rollup / importer could match the flat comparison plan and misprice cell F. (Primary call site: `rollup-service.ts` `new Schedule(site.tariffs, …)`; also any live/next-period consumers — `importer`, `load-timing`, `next-cheaper-period`, `energy-repo`.)
- **Importer:** never tags `EnergyData` with a reporting-only tariff, never treats one as the metered `is_current`.
- **ROI read side:** loads the **reporting-only** Fixed tariff to source cells A/C/E.

Implementation note: prefer filtering at the **`Schedule`-construction boundary** (where `site.tariffs` is assembled for metering) so the matcher itself stays unaware of the flag — fewer places to forget. A focused helper (e.g. `meteredTariffs(tariffs)`) keeps the filter in one cohesive, testable unit rather than duplicated at each call site.

## Read side

The fold is unchanged — only the rate *source* changes. Today (`page.tsx:307‑313`):

```ts
const configInputs = { fixedBuyRate: roiConfig.fixed_buy_rate, fixedSellRate: roiConfig.fixed_sell_rate };
roiSummary = buildRoiSummary(rows, configInputs, …);
```

After: a small resolver loads the site's reporting-only Fixed tariff and extracts its single buy/sell rate into the same `RoiInputs` shape. `computeMatrixTotals` / `buildRoiSummary` signatures are untouched.

```
resolveFixedBaseline(siteId) -> { fixedBuyRate, fixedSellRate } | null
  load reporting-only Fixed tariff for site
  pick the CURRENT version (is_current / latest effective_from)   // this phase: one rate for all rows
  return resolveRates(its only period)                            // null when not yet configured
```

This phase prices **all** rollup rows at the current version's rate, even when the user has entered multiple dated versions (the timeline is captured and displayed, not yet priced). **F1** replaces this with a per-row `resolveFixedBaseline(siteId, localDate)` that picks the version effective on each row's date.

When `null` (baseline not configured), the Savings surface shows the existing empty state. Plan detection, "you are here", and the flat-plan recommendation are unaffected — they classify the *active metered* tariff.

## UI

- **Comparison-tariff editor with a Fixed/TOU toggle**, reusing the existing tariff-editor components in a `reporting_only` context. **Fixed** mode collapses to a single buy + sell pair and mints the flat chain above (with the `0..6` day-of-week fix). **TOU** mode opens the full schedule but is a **placeholder** until 2b — it falls back to the actual metered tariff as the baseline.
- **Rate timeline:** the editor captures `effective_from` per version and lets the user enter more than one Fixed version. Comparison plans are **labeled and ordered by `effective_from`** (derived ranges; latest shown as "current").
- **Honest "not yet applied" note:** when a timeline has more than one version, the UI states plainly that historical rates are captured but not yet applied to pricing — pricing uses the current rate (until F1). This is the required guard against implying date-resolved accuracy we haven't built.
- The fixed-rate inputs **leave `RoiConfigForm`** (which keeps costs + install dates). The form/route that previously wrote `fixed_buy_rate` / `fixed_sell_rate` (`api/site/[id]/roi-config`) stops doing so; the baseline is written via the comparison-tariff editor instead.

## Testing

- **Flat-tariff mint (the gotcha):** a minted Fixed comparison tariff resolves a **non-null** period for a Wednesday 03:00 sample *and* a Sunday 20:00 sample (guards the `from_day_of_week=0, to_day_of_week=6` requirement and full-year season coverage).
- **Exclusion:** the metered `Schedule` / `getTariffPeriod` never returns a `reporting_only` tariff; the importer skips them. A site with both a metered TOU tariff and a reporting-only Fixed tariff prices cell F from the TOU tariff only.
- **Read-side parity:** the Fixed column (A/C/E) priced from a reporting-only Fixed tariff at rate *r* equals the pre-refactor scalar math at the same *r* (regression guard on the fold).
- **Effective-date display:** multiple Fixed versions are ordered by `effective_from` with correct derived ranges; pricing still uses the current version for **all** rows (parity with single-rate behavior); the "not yet applied" note renders when >1 version exists.
- **Empty state:** no reporting-only Fixed tariff ⇒ `resolveFixedBaseline` returns `null` ⇒ Savings shows the empty state, no crash.

## Honest caveat

On its own this phase is largely an architectural refactor — the same numbers on a cleaner substrate, plus a captured-but-not-yet-priced rate timeline — whose user-visible *pricing* payoff is realized when F1/F2/2b land on top of it.

## Follow-ons (documented, not built here)

### F1 — Comparison-column past-dating (read-side pricing)
The `effective_from` column ships in this phase (display only). F1 wires it into the **comparison** columns: replace the current-version resolver with a per-row `resolveFixedBaseline(siteId, localDate)` that prices each rollup row at the comparison rate in effect on its date. Read-side, **no re-rollup**; this corrects the fixed-column history (the originating $0.16580→$0.19342 overstatement) and turns the displayed dates into real pricing. Removes the "not yet applied" note. **Out of scope:** future-dated rates (unknowable forward; projection carries the latest rate flat).

### F2 — Metered historical correction (Schedule date-resolution + re-rollup)
The **metered** tariff (cell F): make the metered `Schedule` resolve the version whose `effective_from` window covers a timestamp (with `is_current` fallback so undated versions behave exactly as today), then **re-replay** 5-min history through the corrected schedule (reuse the history-indexing backfill). Because cell F's rate is snapshotted at write time and the row is keyed by `tariff_schedule_id`, an in-place re-price won't do. Closes "the hole where my past tariff period is not representative of reality." Builds on the `effective_from` column from this phase.

### 2b (already on the books) — plan-agnostic hourly profile
Activates the toggle's independent-TOU branch and TOU-to-TOU what-ifs (shift-my-peak-window), by storing a re-bucketable hourly energy profile. The reporting-only flag introduced here is the same one 2b's comparison plans use.

## Resolved decisions (from brainstorming)

1. **Unify on tariffs:** the fixed baseline becomes a `reporting_only` `Tariff`, not a `SiteRoiConfig` scalar nor a bespoke `SiteFixedBuyRate` table. Reusing the tariff machinery only became viable because effective-dating (F1/F2) removes the multi-year objection; this phase lays that foundation.
2. **Sell stays flat:** captured as the flat schedule's single sell rate.
3. **Editor toggle:** one comparison-plan editor, Fixed/TOU toggle; Fixed functional now, TOU a placeholder until 2b.
4. **Effective dates: capture + display now, price later.** Add `effective_from` per `Tariff` version this phase for labeling/ordering; pricing stays single-current-rate with an explicit "not yet applied" note. Comparison-column date pricing → F1; metered correction → F2. Chosen to avoid the perception trap of showing dates that don't affect numbers, while still capturing the timeline forward-compatibly.
5. **No migration:** existing fixed scalars not ported; user re-enters once; columns left deprecated.
6. **Flag boundary:** exclude reporting-only tariffs at the metered-`Schedule` construction boundary via a single cohesive helper, not scattered call-site checks.
