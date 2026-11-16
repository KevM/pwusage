# URDB Estimated Rate Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the days no owner or Tesla rate plan covers with plans estimated from the OpenEI Utility Rate Database (URDB), give each Tesla plan a sourced start date, and build the fixed reference timeline automatically, so bills, savings and server attribution need fewer "Fix Rate Plans" / "Edit Fixed Rate Plan" caveats.

**Architecture:** A server job per site (queued, run by a pg_cron-triggered route like `reattribute-tariffs`) finds the site's URDB utility, matches each Tesla plan version to a URDB revision by prices, walks the matched revision's `supersedes` chain back in time, and picks the utility's default fixed plan per period for the reference timeline. It stores the results as ordinary append-only `Tariff` rows with `source = 'estimated'` plus a provenance row each, then a pure layout step writes `estimated` spans only into days no `manual`/`tesla` span covers. The same layout step re-runs inside every existing rate plan mutation (no URDB call), so owner edits always win and deleted owner plans are back-filled. Re-attribution is queued for changed actual-timeline days. iOS decodes the new values in PR 1 and gets its pickers, labels and copy in PR 2.

**Tech Stack:** Next.js App Router, `pg`, vitest, Supabase pg_cron (`cmd/next-app`); Swift 6, SwiftUI, Swift Testing, XcodeGen (`cmd/ios-app`).

**Spec:** [`../specs/2026-11-13-savings-and-roi-design.md`](../specs/2026-11-13-savings-and-roi-design.md) §2, §4.2, §4.3, §4.4, §6.2 ("Estimated plans" line). Built on Phase 2 ([`2026-11-14-savings-phase-2.md`](./2026-11-14-savings-phase-2.md)) and the coverage caveats ([`2026-11-15-savings-coverage-caveats.md`](./2026-11-15-savings-coverage-caveats.md), #375). Decisions below were made with the owner on 2026-11-15 and take precedence over the spec.

**Base:** `main` at `9f63f722` (#375 merged).

## Decisions (beyond or replacing the spec)

- **Two PRs.** PR 1 (Tasks 1–9): everything on the server plus the Swift *contract* (decode the new values, an "Estimated" badge, no delete on estimated plans), because Swift decodes `TariffSource` as a strict enum and the cross-app rule needs both sides in one PR. PR 2 (Tasks 10–13): iOS utility and plan pickers, start-date source labels, estimate copy, out-of-date notice, estimated share on savings; mockups gate the UI.
- **Matching:** prices decide, names only break ties. Tesla stores its plan under the utility's name (`parseTariffContent` uses `content.utility`), the plan name/code exists only for the current plan in `Site.json`, and many are "(edited)". A URDB revision matches a Tesla version when every cell of 12 months × {weekday, weekend} × 24 hours has |Tesla buy − URDB buy| ≤ `0.005`, where URDB buy is tier 1 `rate + (adj ?? 0)`, or tier 1 `rate` alone (either form may match; Tesla rates sometimes exclude riders). Tesla is evaluated on the 15th of the month at `hh:30`. Among several matches prefer, in order: token overlap between Tesla `plan_name`/`plan_code` and the URDB name, the later `startdate`, the lexically larger `label`.
- **Start-date sources** (stored per Tesla version, see Storage):
  - matched → the revision's `startdate`, `urdb` ("From public utility rates");
  - unmatched, not the site's first Tesla version → the version's first-seen date (`Tariff.updated`, site-local), `tesla_first_seen` ("First seen in Tesla");
  - unmatched first version → **only ever moves earlier**: `min(current span start, Jan 1 of the first-seen year)`; `assumed_jan_1` when Jan 1 is used, else `history_start` (the span already reached further back, e.g. backfilled to the first archived day).
  - A Tesla span whose `updated_by_user_id` is set (the owner edited its dates) is never moved; its `startSource` is `null`.
  - A matched start may move a span *later* only when estimated spans cover every day it frees. No step of this job may uncover a day that was covered before it ran.
- **Actual estimates:** walk `supersedes` back from the revision matched to the site's *earliest* Tesla version. With no Tesla and no owner plan, the owner picks their plan from the utility's current residential plans (PR 2 picker; server endpoint in PR 1) and the walk starts from that revision, open-ended through today. With no Tesla match and no pick, no actual estimates.
- **Reference estimates:** built whenever the utility is known, match or not. Source: the utility's `is_default` residential items (one call with `is_default=true`), filtered to *fixed* items (every month uses one period for all 24 hours on weekdays and weekends; months may differ, e.g. summer/winter).
- **URDB data is messy** (seen 2026-11-15: `enddate` before `startdate`; two `is_default` items with the same `startdate`). Spans therefore come from start dates only: each revision runs from its `startdate` to the day before the next revision's `startdate`; the newest is open-ended (actual: up to the day before the anchor's start). `enddate` is ignored. Same-`startdate` ties: prefer the item in the newest item's `supersedes` chain, else the larger `label`.
- **Field name:** URDB's field is `supersedes` (the spec spells it "supercedes").
- **Conversion** (`TariffPlanWriteInput`, so `validateTariffPlanInput` accepts it): seasons are maximal runs of consecutive months (wrapping Dec→Jan) with identical weekday row, weekend row and period prices; named `Summer`/`Winter` when there are two (the one containing July is `Summer`), else `Season 1…n` in month order; more than 6 seasons → unconvertible. Within a season, distinct buy prices rank to period names: 1 → `OFF_PEAK`; 2 → `ON_PEAK`, `OFF_PEAK`; 3 → add `PARTIAL_PEAK` in the middle; 4 → add `SUPER_OFF_PEAK` lowest; more than 4 → unconvertible. Windows are hourly runs of one name. Plan name = URDB `name` cut to 64 characters. An unconvertible revision ends the chain walk there (older days stay uncovered).
- **Tiers:** flatten every multi-tier period to one blended rate at the site's median monthly home use over the last 365 days (from `EnergyRepo.getCycleAggregates` load sums). Tier `max` units: `kWh` = per month; `kWh daily` × 30.4 = per month; any other unit → unconvertible. No usage data → tier 1 rate.
- **Sell rates:** the item's tier 1 `sell` when present; else buy when `dgrules === 'Net Metering'`; else, for actual estimates, the average sell rate of the anchor Tesla plan (or, for an owner-picked plan, `0`), and for reference estimates the average sell rate of the actual plan `pickActivePeriodForDate` returns for the reference span's start (`0` when there is none).
- **Where the walk runs:** a background job, never in a request. pg_cron every 10 minutes calls `GET /api/cron/urdb-estimates` *only when* a site is due (pattern of `20261111144642_reattribute_tariffs_cron.sql`). The route runs sites serially within a 40 s budget (`maxDuration = 60`), at most `URDB_SITES_PER_RUN = 5` sites. A site costs about 20 URDB calls (one `effective_on_date` list per Tesla version, one `getpage` per chain step, one `is_default` list, one list for today's out-of-date check), memoised per run. Ready sites are rechecked weekly (`next_check_at`), which also catches new URDB revisions.
- **Nothing raw from URDB is stored in the database.** The utility list is cached with `fetch(..., { next: { revalidate: 604800 } })` plus a module memo; only the converted `Tariff` rows (a few KB each) and small provenance rows are stored. Estimated `Tariff` rows are reused by `(site_id, urdb_label, content_hash)` so weekly rechecks add nothing when URDB hasn't changed.
- **API key:** `OPENEI_API_KEY`, server-only env var (Prod, beta, preview). Missing key → the runner logs `urdb.disabled` once per run and does nothing; search endpoints return 503. `DEMO_KEY` works for recording fixtures (30 calls/hour, 50/day).
- **Utility lookup:** normalised exact match (lowercase, trim, collapse spaces, `&`↔`and`, drop trailing `co`/`inc`/`company`) of `Site.utility` against the cached `utility_companies` list, then a checked-in alias map, else the site needs the owner to pick. No location, ever.
- **Editing estimated plans:** PATCH on an estimated period turns it into an owner plan (a new `manual` Tariff with the patch applied, replacing that span; re-attribution queued). DELETE on an estimated period is refused with 400 `Estimated rate plans fill days without a plan. Add your rate plan to replace one.` The owner turns estimates off by choosing "My utility isn't listed" (`skipped`), which removes all estimated spans.
- **Limits:** `MAX_EFFECTIVE_PERIODS_PER_SITE` (50) counts `manual` + `tesla` spans only; estimated spans are capped at `MAX_ESTIMATED_PERIODS_PER_TIMELINE = 80` (chain walk stops there). `assertPlanNameAvailable` ignores estimated spans.
- **Versions:** `insertTariffGraph` numbers versions `MAX(version)+1` per `(site_id, name)`, not per site. Insert a chain's new estimated rows oldest first so versions rise with time.

## Storage

One migration (`npm run create-migration -- urdb_estimated_rate_plans` or the repo's generator; copy the RLS header):

- `Tariff.source` and `TariffEffectivePeriod.source` checks allow `'estimated'` (drop and re-add `tariff_source_check` and the period's inline check by name).
- `TariffReferencePeriod.source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','estimated'))`.
- `Tariff.plan_name TEXT NULL`, `Tariff.plan_code TEXT NULL` (Tesla's `tariff_content_v2.name`/`code`, set for new Tesla versions; the job fills the latest Tesla version when its content hash equals the hash of `Site.json`'s plan).
- `"SiteUtility"(site_id TEXT PK FK Site ON DELETE CASCADE, urdb_utility TEXT NULL, choice TEXT NOT NULL CHECK (choice IN ('auto','owner','skipped')), urdb_plan_label TEXT NULL, status TEXT NOT NULL CHECK (status IN ('pending','running','ready','needs_utility','needs_plan','failed')), attempt_count INT NOT NULL DEFAULT 0, last_error TEXT NULL, checked_at TIMESTAMPTZ NULL, next_check_at TIMESTAMPTZ NULL, updated_by_user_id TEXT NULL FK User ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
- `"TariffUrdbSource"(tariff_id INT PK FK Tariff ON DELETE CASCADE, site_id TEXT NOT NULL FK Site ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('tesla_anchor','estimated_actual','estimated_reference')), urdb_label TEXT NULL, start_date DATE NOT NULL, end_date DATE NULL, start_source TEXT NOT NULL CHECK (start_source IN ('urdb','tesla_first_seen','assumed_jan_1','history_start')), newer_urdb_label TEXT NULL, newer_urdb_name TEXT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`, index `(site_id, role)`. For estimated rows `start_date`/`end_date` are the *desired* (unclipped) span; the layout step clips them.
- Both new tables: RLS on, revoke `PUBLIC, anon, authenticated`, grant `service_role` (+ sequence grants if any).

Quota: ~60 bytes per provenance row, one estimated `Tariff` graph (~1–3 KB) per URDB revision per site. Tens of KB per US site; nothing for non-US sites.

## Wire contract (TS `tariff-contract.ts` ⇄ Swift `MobileTariffs.swift`, same PR)

- `TariffSource = 'tesla' | 'manual' | 'estimated'`.
- `TariffPeriodDTO.startSource: 'urdb' | 'tesla_first_seen' | 'assumed_jan_1' | 'history_start' | null`: for `estimated` periods `'urdb'`; for `tesla` periods the version's anchor source when the span's `effectiveFrom` equals the anchor's `start_date`, else `null`; for `manual` `null`.
- `referencePeriods[].source: 'manual' | 'estimated'`.
- `SiteTariffsTimelineResponse.estimates: { status: 'pending' | 'ready' | 'needs_utility' | 'needs_plan' | 'skipped' | 'failed'; utilityName: string | null; teslaPlanOutOfDate: boolean; newerPlanName: string | null; newerPlanStart: string | null; newestRevisionStart: string | null; mayBeOutdated: boolean } | null` (`null` when the site has no `SiteUtility` row yet). The three added fields: `newerPlanStart` is the YYYY-MM-DD start of the newer URDB revision behind `teslaPlanOutOfDate` (null when unknown); `newestRevisionStart` is the YYYY-MM-DD start of the newest URDB revision behind the estimate covering today; `mayBeOutdated` is true when that newest revision may have missed a rate change. Response stays `version: 2`; Swift decodes `estimates` with `decodeIfPresent`, `startSource` likewise.

## Global Constraints

- Privacy: never send or use location; utility lookup is by name or owner choice only; URDB calls are server-only and carry only the API key, utility name, plan label and dates.
- Owner (`manual`) and Tesla spans always win; estimated spans fill only days neither covers. No step uncovers a previously covered day.
- Append-only `Tariff` (`DesignDecisions.md`): new estimated content is a new row; rows are never updated except `is_current` and the new nullable `plan_name`/`plan_code` fill.
- Copy (`docs/voice-and-terms.md`): "rate plan", never "tariff"; estimates say "about"; Title Case buttons, sentence case body; curly `’`. Fixed strings: `Estimated from public utility rates. Add your rate plan for a better figure.`; `From public utility rates`; `First seen in Tesla`; `Assumed January 1`; `About 40% of these days use estimated rates` (percentage varies). New strings proposed in Task 10 need the owner's approval.
- Server: Vercel Hobby 60 s per function (`maxDuration = 60`, 40 s work budget); crons via Supabase pg_cron, never `vercel.json`; minimise Supabase egress (the cron SQL checks for due rows before calling).
- Tests never call URDB: recorded fixtures only. Dev DB scripts never touch Tesla here, but live checks use the Harrison site only.
- Web CI: `npm run lint`, `npm run typecheck`, `npx vitest run`. iOS CI: `./lint.sh` (swiftformat `--lint`, swiftlint `--strict`, zero warnings) and `./run-tests.sh`; Swift Testing; run `./generate.sh` after adding files. TDD: failing test first.
- iOS is beta: no compatibility shims for old builds.

## Review Focus

1. **Messy URDB dates:** an item whose `enddate` precedes its `startdate`, and two defaults sharing a `startdate`, must still give non-overlapping spans with no gap between consecutive revisions. → Task 4 `chainSpansIgnoreEndDateAndResolveTies`.
2. **Owner edit, then delete, inside an estimated span:** creating a manual plan splits the estimated span; deleting it restores the estimates for exactly those days, and an owner-dated Tesla span is never moved by the job. → Task 6 `deletingManualPlanRefillsEstimates`, Task 5 `ownerDatedTeslaSpanNeverMoves`.
3. **Non-US or unknown utilities** (AGL, Amber, Contact Energy; `Site.json` often has no currency): status `needs_utility`, no URDB rate calls, and the cron does not pick the site again until the owner chooses or a week passes. → Task 7 `unknownUtilityParksSiteForAWeek`.
4. **An estimated plan covering today** (owner-picked plan, no Tesla plan) becomes the current plan for `Schedule`/Smart Shift via `recomputeIsCurrentTariff`, and a later Tesla version replaces it from its start date. → Task 6 `estimatedPlanCoveringTodayBecomesCurrent`.
5. **Owner edits during a job run:** URDB fetches happen outside the transaction; the write phase re-reads spans under `Site ... FOR UPDATE`, so an owner plan saved mid-run is kept. → Task 7 `ownerEditDuringRunWins`.

---

# PR 1 — Server, estimates, and the mobile contract

### Task 1: Schema, types and contract fields

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_urdb_estimated_rate_plans.sql`
- Modify: `cmd/next-app/src/lib/db-types.ts` (`TariffSource`, `Tariff.plan_name/plan_code`, `SiteUtilityRow`, `TariffUrdbSourceRow`), `cmd/next-app/src/lib/tariff-contract.ts` (Wire contract above)
- Test: `cmd/next-app/src/lib/tariff-timeline-repo-postgres.test.ts`

**Interfaces:**
- Produces: the tables and columns in Storage; TS types `TariffStartSource`, `EstimatesStatusDTO`; `SiteUtilityStatus` union matching the SQL check.

- [ ] **Step 1: Write failing postgres tests:** `accepts estimated tariffs and spans`, `reference periods default to manual source`, `rejects unknown tariff source`.
- [ ] **Step 2: Run** `npx vitest run src/lib/tariff-timeline-repo-postgres.test.ts` — FAIL.
- [ ] **Step 3: Implement** the migration and types.
- [ ] **Step 4: Run** the test, `npm run lint`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(db): estimated rate plan source, site utility and URDB provenance tables`.

### Task 2: URDB client, fixtures and utility lookup

**Files:**
- Create: `cmd/next-app/src/lib/urdb/client.ts`, `cmd/next-app/src/lib/urdb/types.ts`, `cmd/next-app/src/lib/urdb/utility-lookup.ts`, `cmd/next-app/src/lib/urdb/utility-aliases.ts`, `cmd/next-app/scripts/record-urdb-fixtures.ts`, `cmd/next-app/src/lib/urdb/__fixtures__/*.json`
- Test: `cmd/next-app/src/lib/urdb/client.test.ts`, `cmd/next-app/src/lib/urdb/utility-lookup.test.ts`

**Interfaces:**
- Produces (types): `UrdbRate { label: string; name: string; utility: string; eiaid?: number; startdate?: number; enddate?: number; is_default?: boolean; supersedes?: string; dgrules?: string; energyratestructure?: UrdbTier[][]; energyweekdayschedule?: number[][]; energyweekendschedule?: number[][] }`, `UrdbTier { rate?: number; adj?: number; sell?: number; max?: number; unit?: string }`.
- Produces (client, all `fetch` with a 15 s timeout, base `https://api.openei.org/utility_rates?version=latest&format=json&sector=Residential`, `limit=500` with `offset` paging):
  - `ratesEffectiveOn(utility: string, date: string /* YYYY-MM-DD */, timeZone: string): Promise<UrdbRate[]>` (`detail=full&effective_on_date=<unix of local noon>`)
  - `rateByLabel(label: string): Promise<UrdbRate | null>` (`getpage=<label>&detail=full`)
  - `defaultRates(utility: string): Promise<UrdbRate[]>` (`detail=full&is_default=true`)
  - `utilityNames(): Promise<string[]>` (`utility_companies`, all pages, `next: { revalidate: 604800 }`, module memo)
  - `class UrdbUnavailableError` for missing key, non-200 and timeouts.
- Produces (lookup): `normalizeUtilityName(name: string): string`; `resolveUtility(siteUtility: string | null, names: string[]): string | null`; `searchUtilities(q: string, names: string[], limit = 20): string[]` (token prefix match, exact-normalised first, then alphabetical).
- `UTILITY_ALIASES: Record<string, string>` keyed by normalised Tesla name. Seed with the US names seen in Dev on 2026-11-15 whose URDB name differs (`PG&E`, `We energies`, `Xcel Energy - Colorado`, `Southern California Edison`, both `Eversource Energy (Formerly …)` names, `PECO Energy Co`, `Tampa Electric Co`, `Puerto Rico Electric Pwr Authority`); each target must exist in the recorded `utility_companies` fixture (test enforces). Skip ambiguous names (`Duke`, `NVEnergy`, `PEC`).
- Fixtures (recorded by the script with `OPENEI_API_KEY` or `DEMO_KEY`, trimmed to the `UrdbRate` fields): `utility-companies.json` (all pages); `we-energies-effective-2026-04-28.json` and the `getpage` chain for its residential TOU Option A plan back to 2014 (supersedes chain, `Net Metering`, fixed default); `we-energies-defaults.json` (contains the bad-`enddate` and duplicate-`startdate` items); `pge-defaults.json` (E-1, tiered, `kWh daily`); one utility whose `dgrules` is not `Net Metering` (pick one from the recordings, e.g. an NEM 3.0 / net billing default) — name it in the fixture file.

- [ ] **Step 1: Write failing tests:** `pages until a short page`, `sends effective_on_date as local noon`, `throws UrdbUnavailableError without a key`, `resolves exact names case and punctuation insensitively`, `resolves aliases`, `every alias target exists in the utility list`, `returns null for non-US utilities` (`AGL`, `Amber Electric`, `Contact Energy`), `search ranks exact matches first`. Mock `fetch`; no network.
- [ ] **Step 2: Run** `npx vitest run src/lib/urdb` — FAIL.
- [ ] **Step 3: Record fixtures** with `npx tsx scripts/record-urdb-fixtures.ts` (reads `OPENEI_API_KEY`, falls back to `DEMO_KEY`); commit them.
- [ ] **Step 4: Implement** client and lookup.
- [ ] **Step 5: Run** tests, lint, typecheck — PASS.
- [ ] **Step 6: Commit** `feat(urdb): server-only OpenEI client, recorded fixtures and utility lookup`.

### Task 3: Convert URDB rates to rate plans

**Files:**
- Create: `cmd/next-app/src/lib/urdb/convert.ts`
- Test: `cmd/next-app/src/lib/urdb/convert.test.ts`

**Interfaces:**
- Consumes: Task 2 types; `TariffSeasonInput`, `TariffPlanWriteInput`, `validateTariffPlanInput` (`tariff-timeline.ts`).
- Produces:
  ```ts
  export interface ConvertContext { medianMonthlyKwh: number | null; fallbackSellRate: number }
  export type ConvertResult = { ok: true; name: string; seasons: TariffSeasonInput[] } | { ok: false; reason: 'no_schedule' | 'too_many_seasons' | 'too_many_periods' | 'unsupported_tier_unit' };
  export function urdbRateToSeasons(rate: UrdbRate, ctx: ConvertContext): ConvertResult;
  export function urdbBuyRateAt(rate: UrdbRate, month: number /*1-12*/, weekend: boolean, hour: number, withAdj: boolean): number | null; // tier 1
  export function blendedTierRate(tiers: UrdbTier[], monthlyKwh: number | null): number | null;
  export function isFixedRate(rate: UrdbRate): boolean;
  ```
- Rules: Decisions "Conversion", "Tiers", "Sell rates" (the fallback is passed in as `ctx.fallbackSellRate`; NEM and `sell` are decided here).

- [ ] **Step 1: Write failing tests:** `weEnergiesTouOptionABecomesOnAndOffPeak` (fixture: two periods, weekday 7:00–19:00 `ON_PEAK` at `0.27006 + 0.00055`, weekends all `OFF_PEAK`), `pgeE1FlattensDailyTiersAtMedianUse` (summer tiers 13.5 / 54 kWh daily at 0.32561 / 0.40702; 600 kWh/month → (410.4 × 0.32561 + 189.6 × 0.40702) / 600), `noUsageFallsBackToTierOne`, `netMeteringSellsAtBuyRate`, `nonNetMeteringUsesFallbackSell`, `ownSellRateWins`, `wrapsWinterAcrossNewYear` (Oct–May season), `moreThanSixSeasonsIsUnconvertible`, `moreThanFourPricesInASeasonIsUnconvertible`, `unknownTierUnitIsUnconvertible`, `outputPassesValidateTariffPlanInput` (every convertible fixture item), `fixedRateDetection` (We Energies Rg 1 true, TOU Option A false, PG&E E-1 true).
- [ ] **Step 2: Run** `npx vitest run src/lib/urdb/convert.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint, typecheck.
- [ ] **Step 5: Commit** `feat(urdb): convert URDB schedules, tiers and sell rates to rate plans`.

### Task 4: Match Tesla plans, walk revisions, pick reference plans

**Files:**
- Create: `cmd/next-app/src/lib/urdb/match.ts`
- Test: `cmd/next-app/src/lib/urdb/match.test.ts`

**Interfaces:**
- Consumes: Task 3 `urdbBuyRateAt`, `isFixedRate`; `Tariff` with seasons/schedules (`db-types.ts`), `Schedule` lookup helpers in `schedule.ts` for evaluating Tesla buy rates.
- Produces:
  ```ts
  export function teslaMatchesUrdb(tesla: Tariff, rate: UrdbRate): boolean; // 576 cells, 0.005, with or without adj
  export function pickTeslaMatch(tesla: Tariff, candidates: UrdbRate[]): UrdbRate | null; // tie-break per Decisions
  export interface RevisionSpan { rate: UrdbRate; effectiveFrom: string; effectiveTo: string | null }
  export async function walkSupersedes(start: UrdbRate, fetchByLabel: (label: string) => Promise<UrdbRate | null>, opts: { endBefore: string | null; maxSteps: number; timeZone: string }): Promise<RevisionSpan[]>; // oldest first; start's own span ends the day before opts.endBefore (null = open)
  export function referenceSpans(defaults: UrdbRate[], timeZone: string): RevisionSpan[]; // fixed defaults only, oldest first
  export function newerRevision(matched: UrdbRate, today: UrdbRate[], fetchByLabel: …): Promise<UrdbRate | null>; // a today-effective item whose supersedes chain (≤10 steps) reaches matched.label with a later startdate
  export function anchorStart(input: { matched: UrdbRate | null; firstSeen: string; isFirstVersion: boolean; currentSpanStart: string; ownerDated: boolean; timeZone: string }): { startDate: string; startSource: TariffStartSource } | null; // null = leave as is (ownerDated)
  ```
- Dates: URDB unix seconds → site-local `YYYY-MM-DD` via `siteLocalDateString`.

- [ ] **Step 1: Write failing tests:** `matchesTeslaPlanBuiltFromTheSameRevision` (build a Tesla `Tariff` from a fixture revision rounded to the cent → match), `matchesWithoutAdj`, `rejectsHalfCentPlusOne`, `unmatchedEditedPlanReturnsNull`, `tieBreaksByNameThenNewestStart`, `walksWeEnergiesChainBackTo2014`, `chainSpansIgnoreEndDateAndResolveTies`, `walkStopsAtMaxStepsAndMissingLabels`, `referenceSpansKeepOnlyFixedDefaults`, `pgeReferenceUsesE1`, `newerRevisionFoundThroughSupersedes`, `anchorStart` cases: matched → `urdb`; later version → `tesla_first_seen`; first version backfilled to 2023-11-14, first seen 2026-04-28 → stays 2023-11-14 `history_start`; first version starting 2026-04-28 → 2026-01-01 `assumed_jan_1`; owner-dated → `null`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint, typecheck.
- [ ] **Step 5: Commit** `feat(urdb): match Tesla plans to URDB revisions and walk their history`.

### Task 5: Pure layout of estimated spans and Tesla start moves

**Files:**
- Create: `cmd/next-app/src/lib/tariff-estimates.ts`
- Test: `cmd/next-app/src/lib/tariff-estimates.test.ts`

**Interfaces:**
- Consumes: `ExistingSpan`, `NewSpanRow`, `addCalendarDays` (`tariff-timeline.ts`).
- Produces:
  ```ts
  export interface DesiredEstimate { tariffId: number; effectiveFrom: string; effectiveTo: string | null }
  export interface TeslaAnchor { tariffId: number; startDate: string }
  export interface EstimateLayout { deleteIds: number[]; inserts: NewSpanRow[]; changed: Array<{ from: string; to: string | null }> }
  export function layoutTimeline(existing: ExistingSpan[], anchors: TeslaAnchor[], desired: DesiredEstimate[]): EstimateLayout;
  ```
- Algorithm: (1) drop all existing `estimated` spans; (2) for each Tesla span with an anchor and `updatedByUserId === null`, move its start to the anchor: earlier only across days held by estimates or by an earlier non-owner-dated Tesla span (trim that span), never across `manual` or owner-dated spans; later only if every freed day is covered by `desired`; (3) fill each uncovered day range with the `desired` estimates clipped to it; (4) `changed` = day ranges whose covering tariff differs from before (for re-attribution). Used for the reference timeline too, with no anchors and `manual`/`estimated` sources.

- [ ] **Step 1: Write failing tests:** `estimatesFillOnlyUncoveredDays`, `manualAndTeslaAlwaysWin`, `teslaStartMovesEarlierOverEstimates`, `teslaStartNeverCrossesManual`, `ownerDatedTeslaSpanNeverMoves`, `laterStartOnlyWhenEstimatesCoverFreedDays`, `neverUncoversACoveredDay` (property-style over the fixtures: every day covered before is covered after), `changedRangesListOnlyRepricedDays`, `idempotentWhenRunTwice`, `referenceLayoutKeepsManualReferencePlans`.
- [ ] **Step 2: Run** `npx vitest run src/lib/tariff-estimates.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint, typecheck.
- [ ] **Step 5: Commit** `feat(tariffs): lay out estimated spans around owner and Tesla plans`.

### Task 6: Apply estimates in the timeline repo and existing mutations

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts`, `cmd/next-app/src/lib/tariff-repo.ts` (`addTariffVersion`), `cmd/next-app/src/lib/tariff-timeline.ts` (cap counting), the reference write paths added in Phase 2 (`createReferencePeriod`, `updateReferencePeriod`, `deleteReferencePeriod`), `cmd/next-app/src/app/api/site/[id]/tariffs/[periodId]/route.ts` (400 message)
- Test: `cmd/next-app/src/lib/tariff-timeline-repo-postgres.test.ts`, `cmd/next-app/src/lib/tariff-timeline-repo.test.ts`, `cmd/next-app/src/app/api/site/[id]/tariffs/[periodId]/route.test.ts`

**Interfaces:**
- Consumes: Task 5 `layoutTimeline`; Task 1 tables.
- Produces: `applyEstimatesOnClient(client: PoolClient, siteId: string, today: string): Promise<{ changed: Array<{ from: string; to: string | null }> }>` — loads spans, anchors (`TariffUrdbSource` role `tesla_anchor`), desired spans (roles `estimated_*`), applies both layouts, calls `recomputeIsCurrentTariff`; the caller enqueues re-attribution for `changed` (actual timeline only) with the trigger it already uses.
- Called at the end of `createManualPeriod`, `updatePeriod`, `deletePeriod` (after `healVacatedIntervalWithTesla`), `addTariffVersion` (also stores `plan_name`/`plan_code` and upserts `SiteUtility.status = 'pending'`), and the reference create/update/delete. Re-attribution ranges merge with the mutation's own range.
- `getTimeline` fills `startSource` and `estimates` (Wire contract) and maps `TariffReferencePeriod.source`.
- `updatePeriod` on an estimated span: creates a manual Tariff from the estimated Tariff's seasons + patch (name kept unless patched), replaces the span, `updated_by_user_id = userId`. `deletePeriod` on an estimated span throws `TariffValidationError` with the Decisions message.

- [ ] **Step 1: Write failing tests:** `deletingManualPlanRefillsEstimates`, `creatingManualPlanSplitsEstimate`, `patchingEstimateMakesItAnOwnerPlan`, `deletingEstimateIsRefused` (route → 400 + message), `newTeslaVersionTrimsEstimatesAndQueuesSite`, `estimatedPlanCoveringTodayBecomesCurrent`, `capIgnoresEstimatedSpans`, `planNameCheckIgnoresEstimates`, `timelineReportsStartSourceAndEstimates`, `teslaStartSourceIsNullAfterOwnerMovesIt`, `referenceEditsKeepEstimatesElsewhere`.
- [ ] **Step 2: Run** the three test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm run lint`, `npm run typecheck`, full `npx vitest run`.
- [ ] **Step 5: Commit** `feat(tariffs): estimated plans fill gaps on every rate plan change`.

### Task 7: The URDB estimate job, cron route and schedule

**Files:**
- Create: `cmd/next-app/src/lib/urdb/estimate-job.ts`, `cmd/next-app/src/app/api/cron/urdb-estimates/route.ts` (+ `route.test.ts`), `cmd/next-app/db-migrations/<timestamp>_urdb_estimates_cron.sql`
- Test: `cmd/next-app/src/lib/urdb/estimate-job.test.ts` (fixtures via an injected client), `cmd/next-app/src/lib/urdb/estimate-job-postgres.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6; `EnergyRepo.getCycleAggregates` (median monthly use); `enqueueReattributionOnClient`.
- Produces:
  ```ts
  export interface UrdbApi { ratesEffectiveOn: …; rateByLabel: …; defaultRates: …; utilityNames: … } // Task 2 signatures, injectable
  export async function runUrdbEstimatesForSite(siteId: string, api: UrdbApi, now: Date): Promise<{ status: SiteUtilityStatus; changedDays: number }>;
  export async function runUrdbEstimatesCron(opts: { maxTimeMs: number; maxSites: number; api?: UrdbApi }): Promise<{ checked: number; sites: Array<{ siteId: string; status: SiteUtilityStatus }>; stopped?: 'time' | 'disabled' }>;
  ```
- Due sites (one SQL, oldest first): `SiteUtility.status = 'pending'`; or `running` with `updated_at < now() - 5 min`; or `status IN ('ready','needs_utility','needs_plan','failed') AND next_check_at <= now()`; or a non-orphaned `Site` with no `SiteUtility` row (insert `choice='auto', status='pending'`). `failed` backs off `next_check_at = now() + 2^attempt_count hours` (max 7 days).
- Per site: (1) fetch phase, no transaction: resolve utility (`choice='skipped'` → remove estimates, status `skipped`; unresolved → `needs_utility`, `next_check_at + 7 days`); load Tesla versions with spans; per version `pickTeslaMatch(ratesEffectiveOn(firstSeen))`; build anchors (`anchorStart`); actual chain from the earliest version's match, or from `urdb_plan_label` when the site has no Tesla and no manual plan (none → status `needs_plan`, still build reference); `referenceSpans(defaultRates)`; out-of-date via `newerRevision` for the latest Tesla version; convert every revision (Task 3), sells per Decisions. (2) write phase, one transaction with `SELECT … FROM "Site" … FOR UPDATE`: insert or reuse estimated `Tariff` rows (oldest first), replace the site's `TariffUrdbSource` rows, `applyEstimatesOnClient`, enqueue re-attribution for the merged `changed` range (trigger `'tesla_sync'` is wrong — add `'estimate'` to `EnqueueReattributionParams.trigger`), set `status='ready'`, `checked_at`, `next_check_at = now + 7 days`. Log `urdb.site.completed` with counts and a `matchOutcome` per Tesla version (`matched` | `no_match` | `unconvertible` | `no_utility`), so the match rate can be measured and tuned (no utility or plan names in logs beyond the URDB label).
- Cron SQL: every 10 minutes, `net.http_get` to `/api/cron/urdb-estimates` built from the `battery_restore_cron_target_url` vault secret like the reattribution cron, guarded by `EXISTS` of a due site (same predicate as above).
- Route: `CRON_SECRET` bearer, `maxDuration = 60`, `withIoDeadline(50_000)`, budget `maxTimeMs: 40_000`, `maxSites: 5`.

- [ ] **Step 1: Write failing tests:** `buildsEstimatesForWeEnergiesSite` (fixture Tesla plan matching Option A 2025-06-01; actual chain fills from history start to 2025-05-31; reference from Rg 1 defaults; re-attribution queued for the changed days), `teslaPlanWithNoMatchGetsReferenceOnly`, `noTeslaNoOwnerPlanNeedsPlan`, `ownerPickedPlanFillsThroughToday`, `unknownUtilityParksSiteForAWeek`, `skippedRemovesEstimates`, `ownerEditDuringRunWins` (owner manual plan inserted between fetch and write phase), `outOfDateTeslaPlanIsReported`, `rerunReusesEstimatedTariffs` (no new `Tariff` rows), `failureBacksOff`, `disabledWithoutKey`, route `rejectsWithoutCronSecret`.
- [ ] **Step 2: Run** `npx vitest run src/lib/urdb src/app/api/cron/urdb-estimates` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint, typecheck, full vitest.
- [ ] **Step 5: Commit** `feat(urdb): background job builds estimated rate plans per site`.

### Task 8: Utility and plan endpoints

**Files:**
- Create: `cmd/next-app/src/app/api/site/[id]/utility/route.ts`, `…/utility/search/route.ts`, `…/utility/plans/route.ts`, `…/utility/plan/route.ts` (each with `route.test.ts`)
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts` (`setSiteUtility`, `setSitePlanLabel`)

**Interfaces:**
- Auth exactly as `POST /api/site/{id}/tariffs` (`getCurrentUser` + `verifySiteAccess`); errors map the same way; `UrdbUnavailableError` → 503 `{ error: 'Utility rates are unavailable right now.' }`.
- `GET /api/site/{id}/utility/search?q=` (q trimmed, 2–64 chars, else 400) → `{ utilities: string[] }` (≤ 20, Task 2 `searchUtilities`).
- `PUT /api/site/{id}/utility` body `{ name: string } | { skipped: true }` → name must be in `utilityNames()` (else 400); upsert `SiteUtility(choice='owner'|'skipped', urdb_utility, urdb_plan_label=NULL, status='pending')`; returns `SiteTariffsTimelineResponse`.
- `GET /api/site/{id}/utility/plans` → `{ plans: Array<{ label: string; name: string; startDate: string }> }`: the site's utility's residential rates effective today (`ratesEffectiveOn`), convertible ones only, sorted by name; 409 when the site has no utility.
- `PUT /api/site/{id}/utility/plan` body `{ label: string }` → label must be in that list; sets `urdb_plan_label`, `status='pending'`; returns the timeline.

- [ ] **Step 1: Write failing tests** per route: auth (401/403), validation (400), happy path, 503 without key, `plan route requires a utility` (409).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint, typecheck.
- [ ] **Step 5: Commit** `feat(api): pick a utility and rate plan for estimates`.

### Task 9: Swift contract, minimal labels, web label, live check

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` (`TariffSource.estimated`, `TariffStartSource`, `SiteRateEstimatesDTO`, `startSource`, `estimates`), `cmd/ios-app/PWUsage/Views/Bill/TariffPeriodCardView.swift` (badge `Estimated`, tint `.orange`; no Delete for estimated), `cmd/ios-app/PWUsage/Demo/DemoFixtures.swift` (one estimated period), `cmd/ios-app/PWUsage/Networking/PWUsageAPI+Tariffs.swift` + `DashboardContracts.swift` + `DemoAPI.swift` (five utility calls: `searchUtilities(siteID:query:) -> [String]`, `setUtility(siteID:name:) -> SiteTariffsTimelineResponse`, `skipUtility(siteID:) -> SiteTariffsTimelineResponse`, `utilityPlans(siteID:) -> [UtilityPlanDTO]` with `struct UtilityPlanDTO: Decodable, Sendable, Identifiable { let label: String; let name: String; let startDate: String; var id: String { label } }`, `setUtilityPlan(siteID:label:) -> SiteTariffsTimelineResponse`), `cmd/next-app/scripts/run-urdb-estimates.ts` (live-check script, `--site <id>` required, `--dry-run` runs the fetch phase and prints the planned layout without writing); any web component that renders `TariffPeriodDTO.source` (search `cmd/next-app/src` for `'manual'` in `.tsx`) shows `Estimated` for the new value.
- Test: `cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests.swift` (or the existing decoding suite)

- [ ] **Step 1: Write failing Swift tests:** `decodesEstimatedSourceAndStartSource`, `decodesEstimatesBlock`, `decodesTimelineWithoutEstimates` (existing fixture JSON → `nil`).
- [ ] **Step 2: Run** `./run-tests.sh --quick MobileTariffsDecodingTests` — FAIL.
- [ ] **Step 3: Implement**; `./generate.sh` if files were added.
- [ ] **Step 4: Run** `./lint.sh` and `./run-tests.sh` (full) — PASS, zero warnings; web lint, typecheck, vitest.
- [ ] **Step 5: Live check on Dev (Harrison only):** with `OPENEI_API_KEY` set in the worktree `.env` (Dev DB), run `runUrdbEstimatesForSite` for the Harrison site through a small script (`npx tsx scripts/run-urdb-estimates.ts --site <harrison id> --dry-run`, then without `--dry-run`); record in the PR body: matched revision or not, anchor and source, estimated spans per timeline, re-attribution range. No Tesla calls are made.
- [ ] **Step 6: Commit** `feat(ios): decode estimated rate plans and their start-date sources`, push, open a **draft** PR, bind it, add the `OPENEI_API_KEY` Vercel env var step to the PR's checklist for the owner.

---

# PR 2 — iOS pickers, labels and estimate copy

Branch from `main` after PR 1 merges.

### Task 10: Mockups (gate for Tasks 12–13)

- [x] **Step 1:** Publish mockups as an Artifact: Rate Plans screen with an estimated plan (badge, `Estimated from public utility rates. Add your rate plan for a better figure.`), each start-date source label under the dates (`From public utility rates`, `First seen in Tesla`, `Assumed January 1`, and a proposed label for `history_start`, e.g. `Assumed from your first day of data`), the out-of-date notice (proposed: `Your Tesla rate plan looks out of date. Newer rates took effect <date>. Update it in the Tesla app or add your rate plan here.`), the utility picker (search, `My Utility Isn’t Listed`), the possibly-outdated note (proposed: `These estimated rates started <date> and may be out of date. Add your rate plan for a better figure.`), the plan picker for sites without a Tesla plan, the `needs_utility`/`needs_plan` prompts on Bill and Solar System, and the savings line `About 40% of these days use estimated rates`.
- [x] **Step 2:** The owner approves or edits. **Tasks 12–13 don't start until then.** Record the approved copy here.

**Mockup revision (2026-11-16):** Use the existing tab bar accessory on Home when missing utility or plan setup prevents current pricing. Offer one choice at a time, starting with the utility. Dismissal applies to the current site and keeps setup available in Bill and Solar System. Existing history accessories keep precedence.

**Approved copy (owner, 2026-11-16, mockups: https://claude.ai/artifact/9pHvzifhU753vU8YczWgkP):**

- Start-date labels (caption under the date range): `urdb` → `From public utility rates`; `tesla_first_seen` → `First seen in Tesla`; `assumed_jan_1` → `Assumed January 1`; `history_start` → `From your first day of data`; `null` → no label.
- Estimated plan card note: `Estimated from public utility rates. Add your rate plan for a better figure.`
- Out-of-date notice (Rate Plans, top; only when `teslaPlanOutOfDate`): `Your Tesla rate plan looks out of date. Newer rates took effect <date>. Update it in the Tesla app or add your rate plan here.` with an `Add Rate Plan` button. `<date>` is the newer revision's start (`Jan 1, 2026`); without a date: `Your Tesla rate plan looks out of date. Update it in the Tesla app or add your rate plan here.`
- May-be-outdated note (on the estimated card covering today; only when `mayBeOutdated`): `These estimated rates started <date> and may be out of date. Add your rate plan for a better figure.`
- Rate Plans utility row: `Utility` · utility name (or `Not Set`), opens the utility picker.
- Utility picker: title `Your Utility`, search prompt `Search utilities`, header `Your utility’s public rates fill days without a rate plan, so bills and savings can be estimated.`, button `My Utility Isn’t Listed` with footer `Rate plans stay as they are. You can choose a utility later in Rate Plans.`, footer `Utility names and rates come from the OpenEI Utility Rate Database. Only the utility name is used; never your location.`
- Plan picker (no Tesla plan): title `Your Rate Plan`, header `Choose the plan on your <utility> bill. Its public rates price days without a rate plan, through today.`, section `Residential plans`, rows plan name + `Since <date>`, footer `Not sure? The plan name is on your bill. Adding your rate plan in Rate Plans gives a better figure.`, button `Change Utility`.
- Home tab bar accessory (one step at a time, per-site `Not now` dismiss, history accessories keep precedence): `.pickUtility` → `Choose your utility` / `To estimate rates for days without a plan`; `.pickPlan` → `Choose your rate plan` / `<utility> · prices days without a plan`. Inline placement shows the title only.
- Bill card and Solar System Savings rows: `.pickUtility` → `Choose your utility` / `Your utility’s public rates can estimate days without a rate plan.` / button `Choose Utility` (Bill also offers `Add Rate Plan`); `.pickPlan` → `Choose your rate plan` / `Your <utility> plan’s public rates can estimate days without a rate plan.` / button `Choose Rate Plan`.
- Savings share line: `About 40% of these days use estimated rates`; under 1% → `Some of these days use estimated rates`; none → no line.

### Task 10b: Flag estimates whose URDB revision may be outdated

URDB lags tariff changes (We Energies Rg 2 changed on 2026-01-01; URDB's newest Option B still starts 2025-06-01, see PR #376 "Known limits"). A revision with no `enddate` stays current as far as URDB knows, so the app can only say an estimate *may* be out of date, never that it is.

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-contract.ts` and `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` (same PR), `cmd/next-app/src/lib/urdb/estimate-job.ts`, `cmd/next-app/src/lib/tariff-timeline-repo.ts` (`getTimeline`), plus storage for the newest revision date and the utility's typical gap (a `SiteUtility` column pair, or derived from `TariffUrdbSource`)
- Test: `cmd/next-app/src/lib/urdb/match.test.ts` (rule), `cmd/next-app/src/lib/tariff-timeline-repo-postgres.test.ts` (wire), `cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests.swift`

**Interfaces:**
- `estimates.newestRevisionStart: string | null`: the URDB start date of the newest revision behind an estimate that covers today (actual, else reference).
- `estimates.mayBeOutdated: boolean`: true when today is more than `min(15 months, 1.5 × the median gap between that plan's URDB revisions)` after `newestRevisionStart`. 15 months means the newest revision has missed a January, when most changes take effect. The median comes from the walked `supersedes` chain (reference: the default chain); with fewer than 3 revisions use 15 months.

- [ ] **Step 1: Write failing tests:** `mayBeOutdatedAfterFifteenMonths`, `mayBeOutdatedSoonerForFrequentChangers`, `notOutdatedWithoutEstimateToday`, `fewRevisionsUseFifteenMonths`; Harrison-like fixture (newest 2025-06-01, today 2026-11-16) → `true`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; web lint/typecheck; iOS `./lint.sh`.
- [ ] **Step 5: Commit** `feat: flag estimated rates that may be out of date`.

### Task 11: Estimated share in savings

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/Pricing/RatePeriodResolver.swift` (`isEstimated(at: Date) -> Bool`, from the period's `source`), `cmd/ios-app/PWUsage/Models/Savings/SavingsCalculator.swift` (`SavingsFigures.estimatedDays: Int = 0`: counted days with at least one priced slot whose actual *or* reference plan is estimated), `cmd/ios-app/PWUsage/Views/Shared/SavingsPresentation.swift` (`estimatedShareLine(_:) -> String?`: `nil` at 0; percentage = `estimatedDays * 100 / daysWithData` rounded, `<1%` shown as `Some of these days use estimated rates`)
- Test: `cmd/ios-app/PWUsageTests/SavingsCoverageTests.swift`, `cmd/ios-app/PWUsageTests/SavingsPresentationTests.swift`

- [ ] **Step 1: Write failing tests:** `estimatedDaysCountReferenceAndActualEstimates`, `estimatedPlansCountAsCoveredDays` (a gap filled by an estimate is no longer a caveat), `estimatedShareLineRoundsPercent`, `noEstimatedShareLineWithoutEstimates`; the three-year benchmark still passes.
- [ ] **Step 2: Run** `./run-tests.sh --quick SavingsCoverageTests SavingsPresentationTests SavingsCalculatorTests` — FAIL.
- [ ] **Step 3: Implement** (track per day in the existing `priceCycle` loop; no extra resolver calls per slot beyond one `isEstimated` per resolved period change).
- [ ] **Step 4: Run** — PASS; `./lint.sh`.
- [ ] **Step 5: Commit** `feat(ios): show how much of a savings figure uses estimated rates`.

### Task 12: Presentation of sources, estimates and status

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Bill/RateEstimatesPresentation.swift`
- Test: `cmd/ios-app/PWUsageTests/RateEstimatesPresentationTests.swift`

**Interfaces:**
- Produces: `static func startSourceLabel(_ source: TariffStartSource?) -> String?`, `static func estimateNote(for period: TariffPeriodDTO) -> String?`, `static func outOfDateNotice(_ estimates: SiteRateEstimatesDTO?) -> String?`, `static func mayBeOutdatedNote(_ estimates: SiteRateEstimatesDTO?) -> String?` (only when `mayBeOutdated`; never phrased as certain), `static func prompt(_ estimates: SiteRateEstimatesDTO?) -> RateEstimatesPrompt?` with `enum RateEstimatesPrompt { case pickUtility, pickPlan }` (`needs_utility` → `.pickUtility`; `needs_plan` → `.pickPlan`; others `nil`). Copy exactly as approved in Task 10.

- [ ] **Step 1: Write failing tests** for every source label, the estimate note (estimated only), the out-of-date notice (shown only when `teslaPlanOutOfDate`), the may-be-outdated note (shown only when `mayBeOutdated`, with the formatted start date), and each status → prompt.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `./lint.sh`.
- [ ] **Step 5: Commit** `feat(ios): copy for rate plan start-date sources and estimates`.

### Task 13: Utility and plan pickers, wired into Rate Plans, Bill and Solar System

**Files (final names follow the approved mockups):**
- Create: `cmd/ios-app/PWUsage/Views/Bill/UtilityPickerView.swift`, `cmd/ios-app/PWUsage/Views/Bill/UtilityPlanPickerView.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Tariffs.swift` (calls from Task 9; save the returned timeline and refresh savings like existing mutations), `cmd/ios-app/PWUsage/Views/Bill/TariffSheet.swift` / `RatePlansSheet`, `TariffPeriodCardView.swift` (source label, estimate note), `BillView.swift`, `SolarSystemView.swift` (prompt and out-of-date notice)
- Test: `cmd/ios-app/PWUsageTests/UtilityPickerModelTests.swift` (debounced search: 300 ms, ≥ 2 characters, cancels stale queries; selecting saves and dismisses; `My Utility Isn’t Listed` calls `skipUtility`)

- [ ] **Step 1: Write failing tests** for the picker model.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** per mockups.
- [ ] **Step 4: Run** `./run-tests.sh` (full) and `./lint.sh` — PASS, zero warnings. Check light/dark and the largest Dynamic Type in the simulator; screenshot the estimated Rate Plans screen.
- [ ] **Step 5: Commit** `feat(ios): pick a utility and rate plan for estimated rate plans`; push; draft PR. The wrap-up gives the worktree path and `open <worktree>/cmd/ios-app/PWUsage.xcodeproj` for on-device checks.

## Follow-ups (not this plan)

- Per-utility "Time of Use required for solar" rule list (spec §6.1) — needs reference plans first, which this plan provides.
- Tiered pricing without flattening; riders URDB omits.
- Web and TRMNL wording for estimated plans beyond the badge.
- Tune matching from the logged outcomes (`urdb.site.completed`), so more sites get their history filled automatically.
- Send current rates to Tesla when the weekly recheck finds the Tesla plan out of date (owner opt-in per site; builds on the `time_of_use_settings` write probe in draft PR #360 and a reverse of `parseTariffContent`; the written plan returns as a new Tesla version that matches its URDB revision, so it anchors without a loop).
