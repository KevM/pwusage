# Rate Plan History Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guided iOS flow helps an owner say which public rate plans they were on, year by year, back to the start of their history, and saves those spans as the owner's own rate plans priced from the OpenEI Utility Rate Database (URDB).

**Architecture:** One server call (`GET /api/site/{id}/utility/history`) returns everything the walk-back needs: the window to fill, the years to ask about, and each year's residential plans (fixed or Time of Use, ranked by closeness to the Tesla plan). The phone runs the questions offline as a pure state machine, then sends the chosen periods in one `PUT`. The server expands each period into its URDB revisions (supersedes walk plus one forward lookup), converts them with `convert.ts`, and writes them as `manual` spans in one transaction with one re-attribution job. A new provenance role keeps the "From public utility rates" label on those spans.

**Tech Stack:** Next.js App Router, `pg`, vitest (`cmd/next-app`); Swift 6, SwiftUI, Swift Testing, XcodeGen (`cmd/ios-app`).

**Spec:** [`../specs/2026-11-13-savings-and-roi-design.md`](../specs/2026-11-13-savings-and-roi-design.md) §4.2–4.4, and the URDB plan [`2026-11-15-urdb-estimated-rate-plans.md`](./2026-11-15-urdb-estimated-rate-plans.md) (Decisions, Wire contract, approved copy). PR #376 "Known limits" applies unchanged. The flow was designed with the owner on 2026-11-16; Decisions below settle the details it left open and need the owner's approval with the mockups.

**Base:** `main` at `edfc3342` (#380 merged).

## Decisions

- **Who is offered the guide** (`estimates.historyGuide` non-null): the site has a known utility (`SiteUtility.status` is `ready` or `needs_plan`, choice not `skipped`), its history start (first archived day, else `Site.installed`, site-local) is at least 365 days before today, and at least 30 days in the **fill window** are *unconfirmed*: not covered by a `manual` span. Harrison qualifies: 2023-11-14 to 2026-04-27 is Tesla's backfilled span.
- **Fill window:** from the history start to the day before the **trusted start**, the first day a non-owner-entered source is known to be right:
  - with Tesla versions: the earliest Tesla version's anchor `start_date` when its `start_source = 'urdb'`, else its first-seen date (`Tariff.updated`, site-local). Harrison: 2026-04-28, so the window is 2023-11-14 → 2026-04-27;
  - without Tesla versions (only the synthetic "Default Rate" fallback, or none): open-ended through today. The current period is then saved through the existing plan pick (`setSitePlanLabel`, `estimated`, kept current by the weekly job), and only the earlier periods are saved as `manual`.
  - The guide never writes on or after the trusted start, so Tesla stays the live source for Smart Shift.
- **Years asked:** each calendar year from the year before the trusted start's year down to the history start's year, skipping any year whose window days are all covered by `manual` spans. Each year's plan list is the utility's residential plans in effect on its **ask date**: July 1 of that year, clamped into the fill window.
- **One prefetch call, not one call per step.** A per-step design waits on URDB (1–3 s) at every answer and still needs each year's list. The prefetch makes one `effective_on_date` call for today plus one per asked year, at most 4 at a time, under `withIoDeadline(45_000)`. A 2018 site asks about 8 years: 9 calls, about 6 s. After it loads, every step is instant and works with a flaky connection until Save.
- **Plan kind:** `isFixedRate` → `fixed`, else `time_of_use`. Unconvertible items (`urdbRateToSeasons(...).ok === false`) and items without a start date are dropped, as in `GET /utility/plans`. A three-phase item is dropped when a single-phase item has the same name with "Three" replaced by "Single" (residential services are single-phase; the matcher already prefers them).
- **Plans that differ only in Peak hours are one plan.** URDB lists each Peak window of one rate as its own item (We Energies Rg 2 Options A–D: same prices, Peak 7–19, 8–20, 9–21, 10–22), but on a bill it is one rate with the window the owner chose. Time of Use items group when their names are equal after removing an `Option <letter>` token (and the comma or parentheses left around it) and their converted buy prices per season are equal (rounded to 5 decimals). A group is one row named by the stripped name, with one `peakWindows` entry per item; a group of one has a single window and no hours step. The owner then picks the window ("When does your Peak start and stop?"), pre-selected from the Tesla plan.
- **Fewer steps:** a kind with one plan (after grouping) skips the plan list, and a plan with one Peak window skips the hours step. Harrison's Time of Use path is kind → Peak hours → years.
- **Display names** drop `(Single-Phase)`/`Single-Phase` and an `Option <letter>` token (`Residential Time-of-Use Rg 2`, `Residential Rg 1`); saved plans keep the full URDB name.
- **Closeness to the Tesla plan:** `buyRateDistance(tesla, rate)` = the mean of |Tesla buy − URDB buy| over the 576 cells (12 months × weekday/weekend × 24 hours, Tesla evaluated on the 15th at `hh:30`, as `teslaMatchesUrdb` does), taking the smaller of the with-`adj` and without-`adj` means. The latest Tesla version is compared. Within each year's list, the plan (group) holding the item with the smallest distance is flagged `closest`, and that item's window is its `closestWindow` (none without a Tesla plan). It is flagged even outside the half-cent match tolerance. Ties: smaller name. Harrison's closest today is Option B.
- **Tesla shape** (pre-selects the type step): `time_of_use` when the latest Tesla version has more than one distinct buy price across the 576 cells, else `fixed`; `null` without a Tesla plan.
- **Walk-back semantics:** the phone keeps a *current plan* P and the earliest month it is known to cover. For year Y it asks "In Y, were you still on P?" only when a plan with P's (grouped) name is listed for Y; Yes keeps P's Peak hours, so hours are never asked again for P; otherwise it says P isn't listed for Y and goes straight to the type step. **Yes** extends P over all of Y. **No** asks the type, then a plan Q from Y's list, then Q's Peak hours when Q has more than one window, then "About when did you switch to P?": months from February of Y up to P's known start month, default January of Y + 1. Q then becomes the current plan and covers from the start of Y (or the history start) until the switch. The walk ends at the history start's year.
- **"Not sure?"** opens the help sheet: generic signs of each type, then the utility's plan names in effect for that year grouped by kind (the codes, such as `Rg 1` and `Rg 2`, are inside the names), then **Still Not Sure**. On a "still on" step, Still Not Sure keeps the current plan for that year (as Yes), marked "Assumed". On an hours step it picks the window closest to the Tesla plan, else the first. On a type or plan step: with a Tesla plan, Still Not Sure picks Tesla's shape and the closest plan; without one, the utility's default residential fixed plan (the reference timeline's `is_default` choice, `isDefault` on the wire). The review step marks those periods "Assumed".
- **Saved spans** are `manual` spans (they beat estimates and Tesla's backfilled start under #376's layout), with `updated_by_user_id` = the owner, editable and deletable like any owner plan. Each saved `Tariff` gets a `TariffUrdbSource` row with the new role `owner_history` and `start_source = 'urdb'`, so the timeline reports `startSource: 'urdb'` and the card says "From public utility rates". The estimate job's rerun must keep these rows (it deletes only its own roles).
- **Expanding a period** `{ label, from, to }`: fetch `label`, check its utility is the site's, find the newest revision in effect on `to` through `newerRevision` (one `effective_on_date` call), walk `supersedes` back from it (max 40 steps, memoised), lay out spans by start date (existing `spans()` rules), and clip them to `[from, to]`. When the walk doesn't reach `from`, the oldest revision reached extends back to `from` (the owner says they were on this plan; its oldest known prices are the best guess). An unconvertible revision takes the seasons of the next newer convertible revision (else the next older); a period with no convertible revision is a 400.
- **Conversion inputs:** `medianMonthlyKwh` from the estimate job's `monthlyUsage` (export it); `fallbackSellRate` = the latest Tesla version's average sell rate, else `0`. NEM and own `sell` rules stay in `convert.ts`.
- **Names:** each revision is named by `availableEstimateName` (exported from `tariff-timeline-repo.ts`), so revisions of one plan become `… Rg 2` and `… Rg 2 (2024)`.
- **Save rules (server, inside the write transaction under `Site … FOR UPDATE`):** recompute the fill window and the `manual` coverage; drop days outside the window and days already covered by `manual` spans (the owner's own plans always win, even ones added after the prefetch); periods must be non-overlapping, `from ≤ to`, at most 12 per request; the resulting `manual` + `tesla` count must stay within `MAX_EFFECTIVE_PERIODS_PER_SITE` (50), else 400 `That’s more rate plan changes than we can save. Add the older ones in Rate Plans.`. One `enqueueReattributionOnClient` covering the min `from` to the max `to`, trigger `'create'`. Then `applyEstimatesOnClient` as every mutation does.
- **Where it appears:**
  - Rate Plans: an offer card at the top (below the out-of-date notice), with **Find My Rate Plans** and **Not Now** (per-site dismissal, separate key from the setup accessory's).
  - Home tab bar accessory: lowest precedence, after the setup prompts (`pickUtility`/`pickPlan` always come first), per-site dismissal shared with the Rate Plans card's Not Now.
  - After a save, `historyGuide` turns null once the window is confirmed, so the offer disappears on its own.
- **Short screens** (owner, 2026-11-16): one question per screen, no explanatory paragraphs; details live behind "Not sure?".
- **Copy** (proposed; the mockups carry it for approval). "Time of Use" is allowed: this is an explainer surface. Buttons are Title Case. Offer: `Your system has been running since Nov 2023. Want help finding the rate plans you’ve been on?`.

## Wire contract (TS `tariff-contract.ts` ⇄ Swift `MobileTariffs.swift`, same PR)

- `EstimatesStatusDTO.historyGuide: { historyStart: string; fillThrough: string | null; unconfirmedDays: number } | null`. `fillThrough` is the last day of the fill window (`null` = open through today). Swift decodes it with `decodeIfPresent`.
- `TariffPeriodDTO.startSource` is `'urdb'` for `manual` periods whose tariff has an `owner_history` row; unchanged otherwise.
- `GET /api/site/{id}/utility/history` → `RatePlanHistoryResponse`:
  ```ts
  type RatePlanKind = 'fixed' | 'time_of_use';
  interface RatePlanPeakWindow { label: string; fromHour: number; toHour: number }
  interface RatePlanHistoryPlan { name: string; startDate: string; kind: RatePlanKind; isDefault: boolean; closest: boolean; lowRate: number; highRate: number; peakWindows: RatePlanPeakWindow[]; closestWindow: string | null /* a window label */; fixedLabel: string | null /* fixed plans: the URDB label */ }
  interface RatePlanHistoryYear { year: number; askDate: string; plans: RatePlanHistoryPlan[] }
  interface RatePlanHistoryResponse { utilityName: string; historyStart: string; fillThrough: string | null; teslaShape: RatePlanKind | null; current: RatePlanHistoryPlan[]; years: RatePlanHistoryYear[] /* newest first */ }
  ```
  `lowRate`/`highRate` are the min and max converted buy rates ($/kWh) for the examples and the review. A Peak window is the first weekday `ON_PEAK` window of the season containing July (else the first season) of that item; `label` is the item's URDB label. Fixed plans have no windows and carry `fixedLabel`. Sorted by `fromHour`. The label sent on save is the chosen window's label, or `fixedLabel`. 409 `Choose a utility first.` without a utility; 409 `Your rate plan history is already filled.` when `historyGuide` would be null; 503 `Utility rates are unavailable right now.` on `UrdbUnavailableError`/`IoDeadlineError`.
- `PUT /api/site/{id}/utility/history` body `{ periods: Array<{ label: string; from: string; to: string | null }> }` → `SiteTariffsTimelineResponse` (with ETag, as `PUT /utility/plan`). `to: null` is allowed only without Tesla versions and only on the newest period, whose label is then saved through `setSitePlanLabel` instead of as `manual`. Errors: 400 with a message for validation; 409 `Utility changed. Start again.`; 503 as above.

## Global Constraints

- Privacy: never send or use location. URDB calls are server-only and carry only the API key, utility name, plan label and dates.
- Owner (`manual`) spans always win; the guide never overwrites them, and never writes on or after the trusted start.
- Append-only `Tariff` (`DesignDecisions.md`): every saved revision is a new row.
- Auth exactly as the existing tariff writes: `isCrossOriginRequest` → 403, `getCurrentUser` + `verifySiteAccess` → 401; errors map as in `utility/plan/route.ts`.
- Vercel Hobby: `maxDuration = 60`; URDB work under `withIoDeadline(45_000)`; at most 4 concurrent URDB calls; memoise `rateByLabel` and `ratesEffectiveOn` per request.
- Copy follows `docs/voice-and-terms.md`: "rate plan", never "tariff"; "Time of Use" only here and other explainers, never "TOU" in app copy (bills may print it; the help sheet quotes it as `"TOU"` in quotes as something to look for); estimates say "about"; Title Case buttons; curly `’`.
- Tests never call URDB: recorded fixtures only. Live checks use the Harrison site only, on Dev.
- Web CI: `npm run lint`, `npm run typecheck`, `npx vitest run`. iOS CI: `./lint.sh` (zero warnings) and `./run-tests.sh`; Swift Testing; `./generate.sh` after adding files. TDD: failing test first.
- iOS is beta: no compatibility shims.

## Review Focus

1. **The weekly estimate job reruns after a save.** It must keep `owner_history` provenance rows; today it runs `DELETE FROM "TariffUrdbSource" WHERE site_id = $1`. → Task 1 `estimateRerunKeepsOwnerHistoryRows`.
2. **A manual plan added between prefetch and save.** The save must keep the owner's plan and fill only the remaining days. → Task 5 `saveSkipsDaysCoveredByManualPlans`.
3. **Revisions of one plan share a name.** Saving three revisions of `Residential Time-of-Use (Single-Phase, Option B) Rg 2` must not hit the plan-name check. → Task 5 `saveNamesRevisionsWithYears`.
4. **The Tesla plan's live days.** A period whose `to` runs past the fill window is clipped; the Tesla span from the trusted start is unchanged and stays current. → Task 5 `saveNeverTouchesTeslaFromTrustedStart`.
5. **A plan that didn't exist in an earlier year.** The phone must not ask "still on P?" for a year that doesn't list P, and the server extends the oldest revision back when the chain stops short. → Task 7 `asksForPlanWhenCurrentIsNotListed`, Task 4 `oldestRevisionExtendsBackToFrom`.

---

# PR — server, contract and iOS (one PR; UI tasks wait on mockup approval)

### Task 1: Provenance role and timeline field

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_urdb_owner_history.sql` (drop and re-add the `TariffUrdbSource` role check with `'owner_history'` added)
- Modify: `cmd/next-app/src/lib/db-types.ts` (role union), `cmd/next-app/src/lib/tariff-contract.ts` (`historyGuide`), `cmd/next-app/src/lib/urdb/estimate-job.ts` (both `DELETE FROM "TariffUrdbSource"` and the `old` select limited to `role IN ('tesla_anchor','estimated_actual','estimated_reference')`), `cmd/next-app/src/lib/tariff-timeline-repo.ts` (`getTimeline`: `startSource = 'urdb'` for manual periods with an `owner_history` row; `historyGuide` from `loadHistoryWindow`)
- Create: `cmd/next-app/src/lib/urdb/history-window.ts`
- Test: `cmd/next-app/src/lib/urdb/history-window.test.ts`, `cmd/next-app/src/lib/urdb/estimate-job-postgres.test.ts`, `cmd/next-app/src/lib/tariff-timeline-repo-postgres.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HistoryWindowInput { today: string; historyStart: string | null; earliestTesla: { firstSeen: string; anchorStart: string | null; anchorSource: TariffStartSource | null } | null; manualSpans: Array<{ from: string; to: string | null }> }
  export interface HistoryWindow { historyStart: string; fillThrough: string | null; unconfirmedDays: number; askYears: number[] /* newest first */ }
  export function historyWindow(input: HistoryWindowInput): HistoryWindow | null; // null = no offer
  export function askDate(year: number, window: HistoryWindow, today: string): string;
  export const HISTORY_GUIDE_MIN_DAYS = 365; export const HISTORY_GUIDE_MIN_UNCONFIRMED = 30;
  export async function loadHistoryWindow(client: Queryable, siteId: string, today: string): Promise<HistoryWindow | null>; // SQL for the inputs above; used by getTimeline and both routes
  ```
- `getTimeline` sets `estimates.historyGuide = { historyStart, fillThrough, unconfirmedDays }` when the utility is known (status `ready`/`needs_plan`, not skipped) and `historyWindow` is non-null.

- [ ] **Step 1: Write failing tests:** `harrisonWindowEndsBeforeFirstSeen` (history 2023-11-14, Tesla first seen 2026-04-28, `history_start` anchor → fillThrough 2026-04-27, askYears `[2025, 2024, 2023]`), `matchedAnchorIsTheTrustedStart` (`urdb` anchor 2025-06-01 → fillThrough 2025-05-31), `noTeslaFillsThroughToday` (fillThrough null, askYears from last year down), `shortHistoryIsNotOffered` (364 days → null), `manualCoverageSkipsYearsAndCanEndTheOffer` (2024 fully manual → askYears skips it; window fully manual → null), `askDateClampsToTheWindow` (2023 → 2023-11-14; 2026 window ending 2026-04-27 → 2026-04-27), `estimateRerunKeepsOwnerHistoryRows`, `manualPeriodWithOwnerHistoryReportsUrdbStartSource`, `timelineCarriesHistoryGuide`, `skippedUtilityHasNoHistoryGuide`.
- [ ] **Step 2: Run** `npx vitest run src/lib/urdb/history-window.test.ts src/lib/urdb/estimate-job-postgres.test.ts src/lib/tariff-timeline-repo-postgres.test.ts` — FAIL.
- [ ] **Step 3: Implement** the migration (copy the RLS header of `20261116133607_urdb_revision_start.sql`), types and functions.
- [ ] **Step 4: Run** the tests, `npm run lint`, `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(tariffs): rate plan history window and owner history provenance`.

### Task 2: Closeness, plan kind and Tesla shape

**Files:**
- Modify: `cmd/next-app/src/lib/urdb/match.ts`
- Test: `cmd/next-app/src/lib/urdb/match.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function buyRateDistance(tesla: Tariff, rate: UrdbRate): number | null; // null when a cell has no rate
  export function teslaShape(tesla: Tariff | null): RatePlanKind | null;
  export function planKind(rate: UrdbRate): RatePlanKind; // isFixedRate → 'fixed'
  ```
- `teslaMatchesUrdb` is reimplemented on the same private 576-cell evaluator (no behaviour change; its tests stay green). `RatePlanKind` lives in `tariff-contract.ts` (Task 4 adds the rest of the wire types there; add this one now).

- [ ] **Step 1: Write failing tests:** `distanceIsZeroForTheSameRevision`, `harrisonPlanIsClosestToOptionB` (Tesla $0.30/$0.10 8am–8pm, $0.31 winter peak, against the 2026-04-28 fixture: Option B has the smallest distance of the Rg 2 options), `distanceUsesTheSmallerOfWithAndWithoutAdj`, `teslaShapeTimeOfUseWithTwoPrices`, `teslaShapeFixedWithOnePrice`, `teslaShapeNullWithoutPlan`, `planKindFromIsFixedRate` (Rg 1 → fixed, Option A → time_of_use).
- [ ] **Step 2: Run** `npx vitest run src/lib/urdb/match.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint, typecheck.
- [ ] **Step 5: Commit** `feat(urdb): rank public plans by closeness to the Tesla plan`.

### Task 3: History candidates and the prefetch route

**Files:**
- Create: `cmd/next-app/src/lib/urdb/history-candidates.ts`, `cmd/next-app/src/app/api/site/[id]/utility/history/route.ts`
- Modify: `cmd/next-app/scripts/record-urdb-fixtures.ts` (record We Energies `effective_on_date` lists for 2023-11-14, 2024-07-01, 2025-07-01 and 2026-11-16, and the Option B `getpage` chain back to 2018), `cmd/next-app/src/lib/urdb/__fixtures__/*`
- Test: `cmd/next-app/src/lib/urdb/history-candidates.test.ts`, `cmd/next-app/src/app/api/site/[id]/utility/history/route.test.ts`

**Interfaces:**
- Consumes: Task 1 `loadHistoryWindow`, `askDate`; Task 2 `buyRateDistance`, `planKind`; `UrdbApi` (`estimate-job.ts`); `mapWithConcurrency` (write it here if the repo has none: `async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>`).
- Produces:
  ```ts
  export function historyPlans(rates: UrdbRate[], tesla: Tariff | null, defaults: Set<string>): RatePlanHistoryPlan[]; // filter, dedupe three-phase, group by Peak hours, kind, closest, low/high; sorted closest first, then name
  export async function buildRatePlanHistory(input: { api: UrdbApi; utilityName: string; timeZone: string; today: string; window: HistoryWindow; tesla: Tariff | null }): Promise<RatePlanHistoryResponse>;
  ```
- `isDefault` comes from one `api.defaultRates(utilityName)` call (labels set); it is the 1 extra call beyond today + one per year.
- Route `GET`: auth as Global Constraints (no cross-origin check on GET, as `utility/plans`); 409s and 503 per Wire contract; `maxDuration = 60`; `withIoDeadline(45_000)`.

- [ ] **Step 1: Write failing tests:** `historyPlansDropsUnconvertibleAndThreePhaseTwins`, `historyPlansFlagsOnlyTheClosest`, `groupsOptionsThatDifferOnlyInPeakHours` (Rg 2 Options A–D → one plan `Residential Time-of-Use (Single-Phase) Rg 2`, windows 7–19, 8–20, 9–21, 10–22; `closestWindow` = Option B's label for the Harrison Tesla plan), `differentPricesStayApart`, `displayNamesDropPhaseAndOption`, `noTeslaFlagsNoClosest`, `lowAndHighRatesFromConvertedSeasons` (Option B 2025-06-01: 0.10387 + adj and 0.27006 + adj), `buildsHarrisonYearsNewestFirst` (years 2025, 2024, 2023 with ask dates 2025-07-01, 2024-07-01, 2023-11-14), `callsUrdbOncePerYearPlusTodayAndDefaults` (count injected calls = 5), `limitsConcurrencyToFour`; route: `rejectsWithoutUser` (401), `requiresUtility` (409), `alreadyFilled` (409), `unavailableWithoutKey` (503), `returnsHistory` (200 shape).
- [ ] **Step 2: Run** `npx vitest run src/lib/urdb/history-candidates.test.ts src/app/api/site/[id]/utility/history` — FAIL.
- [ ] **Step 3: Record fixtures** with `npx tsx scripts/record-urdb-fixtures.ts` (`OPENEI_API_KEY` or `DEMO_KEY`); commit them trimmed to `UrdbRate` fields.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** — PASS; lint, typecheck.
- [ ] **Step 6: Commit** `feat(api): rate plan history candidates per year`.

### Task 4: Expand chosen periods into revisions

**Files:**
- Create: `cmd/next-app/src/lib/urdb/history-expand.ts`
- Modify: `cmd/next-app/src/lib/urdb/estimate-job.ts` (export `monthlyUsage`, `averageSell`), `cmd/next-app/src/lib/urdb/match.ts` (export `spans` as `revisionSpans`)
- Test: `cmd/next-app/src/lib/urdb/history-expand.test.ts`

**Interfaces:**
- Consumes: `walkSupersedes`, `newerRevision`, `revisionSpans`, `urdbRateToSeasons`.
- Produces:
  ```ts
  export interface HistoryPeriodInput { label: string; from: string; to: string | null }
  export interface ExpandedRevision { label: string; revisionStart: string; from: string; to: string | null; name: string; seasons: TariffSeasonInput[] }
  export class HistoryPeriodError extends Error {} // message is owner-facing
  export async function expandHistoryPeriod(period: HistoryPeriodInput, ctx: { api: UrdbApi; utilityName: string; timeZone: string; today: string; convert: ConvertContext }): Promise<ExpandedRevision[]>; // oldest first, contiguous over [from, to]
  ```
- Errors (`HistoryPeriodError`): label not found or another utility's → `That rate plan isn’t listed for your utility.`; no convertible revision → `We couldn’t read the rates for <name>. Add this rate plan in Rate Plans.`

- [ ] **Step 1: Write failing tests:** `expandsOptionBAcrossItsRevisions` (label effective 2025-07-01, period 2023-11-14 → 2026-04-27 gives the fixture revisions clipped to it, contiguous, no overlaps), `findsTheNewerRevisionForTheEndDate` (an older label with `to` after its successor's start uses the successor's prices from that start), `oldestRevisionExtendsBackToFrom`, `unconvertibleRevisionTakesNewerPrices`, `rejectsAnotherUtilitysLabel`, `rejectsPeriodWithNoConvertibleRevision`, `memoisesLabelFetches` (two periods on one chain fetch each label once).
- [ ] **Step 2: Run** `npx vitest run src/lib/urdb/history-expand.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; lint, typecheck.
- [ ] **Step 5: Commit** `feat(urdb): expand a chosen rate plan period into its public revisions`.

### Task 5: Save the history in one request

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts` (`saveRatePlanHistory`, export `availableEstimateName`), `cmd/next-app/src/app/api/site/[id]/utility/history/route.ts` (`PUT`)
- Test: `cmd/next-app/src/lib/tariff-timeline-repo-postgres.test.ts`, `cmd/next-app/src/app/api/site/[id]/utility/history/route.test.ts`

**Interfaces:**
- Consumes: Task 1 `loadHistoryWindow`; Task 4 `expandHistoryPeriod`; `computeSpanMutations`, `applySpanMutationPlan`, `insertTariffGraph`, `applyEstimatesOnClient`, `enqueueReattributionOnClient`, `setSitePlanLabel`.
- Produces: `TariffTimelineRepo.saveRatePlanHistory(siteId: string, userId: string, expectedUtility: string, revisions: ExpandedRevision[], openLabel: string | null): Promise<SiteTariffsTimelineResponse>`. The route validates the body (Wire contract; dates `YYYY-MM-DD`, sorted, non-overlapping, ≤ 12, at most one `to: null` and only last), expands every period outside the transaction (concurrency 4, shared memo), then calls the repo. The repo, in one transaction: `Site FOR UPDATE`; `UtilityChangedError` when `SiteUtility.urdb_utility` ≠ `expectedUtility`; clip each revision to the recomputed window minus `manual` coverage; insert a `manual` `Tariff` per remaining piece (name from `availableEstimateName`), its span via `computeSpanMutations`, and a `TariffUrdbSource` row (`role 'owner_history'`, `urdb_label`, `start_date`/`end_date` = the piece, `start_source 'urdb'`, `revision_start`); cap check; `openLabel` → the same update `setSitePlanLabel` performs, on this client; `applyEstimatesOnClient`; one re-attribution; invalidate the site cache; log `tariff.history.saved` with period and revision counts only.

- [ ] **Step 1: Write failing tests:** repo: `saveWritesManualSpansForHarrisonWindow` (Tesla span now starts 2026-04-28 and stays current), `saveNamesRevisionsWithYears`, `saveSkipsDaysCoveredByManualPlans`, `saveNeverTouchesTeslaFromTrustedStart`, `saveQueuesOneReattribution`, `saveRejectsOverTheSpanCap` (message per Decisions, nothing written), `openPeriodBecomesThePlanPick` (no Tesla: newest period sets `urdb_plan_label`, status `pending`), `utilityChangedIsRejected`, `savedSpansAreEditableOwnerPlans` (PATCH then DELETE through existing methods work); route: `crossOriginIsForbidden` (403), `rejectsOverlappingPeriods` (400), `rejectsOpenPeriodWithTesla` (400), `rejectsMoreThanTwelve` (400), `returnsTimelineWithETag`.
- [ ] **Step 2: Run** the two test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm run lint`, `npm run typecheck`, full `npx vitest run`.
- [ ] **Step 5: Commit** `feat(api): save rate plan history from public utility rates`.

### Task 6: Swift contract, API calls and demo data

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` (`SiteRateEstimatesDTO.historyGuide: RatePlanHistoryGuideDTO?`), `cmd/ios-app/PWUsage/Networking/PWUsageAPI+Tariffs.swift`, `DashboardContracts.swift`, `cmd/ios-app/PWUsage/Demo/DemoAPI.swift`, `cmd/ios-app/PWUsage/Demo/DemoFixtures.swift` (a demo history: 3 years, Fixed and Time of Use plans)
- Create: `cmd/ios-app/PWUsage/Models/Bill/RatePlanHistoryDTO.swift`
- Test: `cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests.swift`

**Interfaces:**
- Produces (Swift, mirroring the Wire contract): `struct RatePlanHistoryGuideDTO: Decodable, Sendable, Equatable { historyStart: String; fillThrough: String?; unconfirmedDays: Int }`, `enum RatePlanKind: String, Decodable, Sendable { case fixed; case timeOfUse = "time_of_use" }`, `struct RatePlanHistoryPlanDTO: Decodable, Sendable, Identifiable, Equatable { label, name, startDate: String; kind: RatePlanKind; isDefault: Bool; closest: Bool; lowRate: Double; highRate: Double; peakWindows: [RatePlanPeakWindowDTO]; closestWindow: String?; fixedLabel: String?; var id: String { name } }`, `struct RatePlanPeakWindowDTO: Decodable, Sendable, Equatable, Identifiable { label: String; fromHour: Int; toHour: Int; var id: String { label } }`, `struct RatePlanHistoryYearDTO { year: Int; askDate: String; plans: [RatePlanHistoryPlanDTO] }`, `struct RatePlanHistoryDTO { utilityName, historyStart: String; fillThrough: String?; teslaShape: RatePlanKind?; current: [RatePlanHistoryPlanDTO]; years: [RatePlanHistoryYearDTO] }`, `struct RatePlanHistoryPeriod: Encodable, Sendable, Equatable { label: String; from: String; to: String? }`.
- API: `func rateHistory(siteID: String) async throws -> RatePlanHistoryDTO`, `func saveRateHistory(siteID: String, periods: [RatePlanHistoryPeriod]) async throws -> SiteTariffsTimelineResponse` (encode `to` as JSON `null` when nil).

- [ ] **Step 1: Write failing tests:** `decodesHistoryGuide`, `decodesTimelineWithoutHistoryGuide` (existing fixture → nil), `decodesRateHistoryResponse`, `encodesOpenPeriodWithNullTo`.
- [ ] **Step 2: Run** `./run-tests.sh --quick MobileTariffsDecodingTests` — FAIL.
- [ ] **Step 3: Implement**; `./generate.sh`.
- [ ] **Step 4: Run** `./lint.sh` and `./run-tests.sh` — PASS, zero warnings.
- [ ] **Step 5: Commit** `feat(ios): decode rate plan history and its guide`.

### Task 7: Mockup approval (gate for Tasks 8–10)

- [ ] **Step 1:** The owner approves or edits the mockups (https://claude.ai/artifact/UHtHEc2Ww3JNk176bJFGx3, screens A–L) and the open questions below. Record the approved copy and answers here. **Tasks 8–10 don't start until then.**

**Open questions for the owner:**
1. Sites without a Tesla plan: save the current period as the plan pick (`estimated`, follows new public rates) and only earlier periods as owner plans? (Recommended.) Or save everything as owner plans?
2. Show the Home accessory too, or only the Rate Plans card?
3. One saved plan per public rate change (board K, names gain the year), or one owner plan per period priced at its newest revision? (One per change is more accurate and needs no new pricing model.)
4. Copy on screens A–L, including the "Assumed" badge appearing only in Review.

### Task 8: The walk-back as a pure state machine

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Bill/RatePlanHistoryFlow.swift`
- Test: `cmd/ios-app/PWUsageTests/RatePlanHistoryFlowTests.swift`

**Interfaces:**
- Consumes: Task 6 DTOs.
- Produces:
  ```swift
  struct RatePlanHistoryFlow: Equatable, Sendable {
      enum Step: Equatable, Sendable {
          case currentKind                       // "What kind of rate plan are you on now?"
          case currentPlan(RatePlanKind)
          case stillOn(year: Int)                // "In <year>, were you still on <plan>?"
          case kind(year: Int, notListed: Bool)  // notListed: the current plan isn't listed that year
          case plan(year: Int, RatePlanKind)
          case peakHours(year: Int)              // "When does your Peak start and stop?" (only for plans with 2+ windows)
          case switchMonth(year: Int)            // "About when did you switch to <plan>?"
          case review
      }
      struct Span: Equatable, Sendable { let plan: RatePlanHistoryPlanDTO; var windowLabel: String?; var from: String; var to: String?; var assumed: Bool } // label sent = windowLabel ?? plan.fixedLabel
      init(history: RatePlanHistoryDTO, hasTeslaPlan: Bool)
      private(set) var step: Step
      private(set) var spans: [Span]               // newest first
      var preselectedKind: RatePlanKind?            // teslaShape on the first step
      func plans(for step: Step) -> [RatePlanHistoryPlanDTO]
      func switchMonths(year: Int) -> [String]      // "YYYY-MM", newest first; default is January of year + 1
      mutating func chooseKind(_ kind: RatePlanKind)
      mutating func choosePlan(_ plan: RatePlanHistoryPlanDTO)
      mutating func choosePeakWindow(_ window: RatePlanPeakWindowDTO)
      mutating func answerStillOn(_ yes: Bool)
      mutating func chooseSwitchMonth(_ month: String)
      mutating func stillNotSure()                  // per Decisions; marks the span assumed
      mutating func back()
      func periods() -> [RatePlanHistoryPeriod]     // oldest first, contiguous over the window; the newest `to` = fillThrough
  }
  ```
- Rules: Decisions "Walk-back semantics" and "Not sure?". `stillOn` matching is by exact plan name in that year's list.

- [ ] **Step 1: Write failing tests:** `preselectsTeslaShape`, `asksPeakHoursOnlyForGroupedPlans`, `skipsPlanListWhenTheKindHasOnePlan`, `preselectsTheClosestPeakWindow`, `stillOnKeepsPeakHours` (Yes in 2025 sends the 2025 item with the same hours), `harrisonAllYesGivesOnePeriod` (Option B from 2023-11-14 through 2026-04-27), `noInTwentyFourSwitchesInJanuaryByDefault` (Option B from 2025-01-01, Rg 1 2023-11-14 → 2024-12-31), `midYearSwitchMonthStartsTheNewerPlan`, `asksForPlanWhenCurrentIsNotListed`, `skipsYearsTheServerDidNotList` (ask years with gaps), `stillNotSureWithTeslaPicksClosest`, `stillNotSureWithoutTeslaPicksDefault`, `stillNotSureOnAYearKeepsThePlanAssumed`, `backRestoresThePreviousStep`, `openPeriodWithoutTesla` (newest `to` nil when `fillThrough` is nil).
- [ ] **Step 2: Run** `./run-tests.sh --quick RatePlanHistoryFlowTests` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `./lint.sh`.
- [ ] **Step 5: Commit** `feat(ios): rate plan history walk-back`.

### Task 9: Copy, offer rule and the screen model

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Bill/RatePlanHistoryPresentation.swift`, `cmd/ios-app/PWUsage/Models/Bill/RatePlanHistoryModel.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RateEstimatesAccessoryModel.swift` (an offer case below the setup prompts, and its per-site dismissals under a new defaults key `rateHistory.offerDismissedSiteIDs`), `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Tariffs.swift` (`loadRateHistory()`, `saveRateHistory(_:)`: store the returned timeline and refresh savings like the other tariff mutations)
- Test: `cmd/ios-app/PWUsageTests/RatePlanHistoryPresentationTests.swift`, `cmd/ios-app/PWUsageTests/RatePlanHistoryModelTests.swift`, `cmd/ios-app/PWUsageTests/RateEstimatesAccessoryTests.swift`

**Interfaces:**
- Produces: `RatePlanHistoryPresentation` statics for every string in the approved mockups (offer from `historyStart` formatted `MMM yyyy`; each step's title; plan row example `Off-Peak $0.10 · Peak $0.27` from low/high, fixed `$0.19/kWh`; window row `8 AM – 8 PM`; badges `Closest to your Tesla plan`, `Assumed`, `Your utility’s standard plan`); `@MainActor @Observable final class RatePlanHistoryModel` with `state: .loading | .ready(RatePlanHistoryFlow) | .failed`, `isSaving`, `errorMessage`, `isDone`, injected `load` and `save` closures like `UtilityPlanPickerModel`; the accessory rule gains `historyOffer: Bool` input and returns a new `RateEstimatesAccessoryKind.historyOffer` only when no setup prompt applies.

- [ ] **Step 1: Write failing tests:** presentation per string and the two price formats; model `loadsHistory`, `loadFailureShowsRetry`, `saveSendsPeriodsAndFinishes`, `saveFailureKeepsAnswers`; accessory `setupPromptsOutrankTheHistoryOffer`, `historyOfferYieldsToHistoryAccessories`, `dismissedHistoryOfferStaysHidden`.
- [ ] **Step 2: Run** `./run-tests.sh --quick RatePlanHistoryPresentationTests RatePlanHistoryModelTests RateEstimatesAccessoryTests` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `./lint.sh`.
- [ ] **Step 5: Commit** `feat(ios): copy and model for the rate plan history guide`.

### Task 10: Views and entry points

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Bill/RatePlanHistorySheet.swift` (NavigationStack: one view per `Step`, Back via `flow.back()`), `cmd/ios-app/PWUsage/Views/Bill/RatePlanKindHelpSheet.swift`, `cmd/ios-app/PWUsage/Views/Bill/RatePlanHistoryOfferCard.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/RateEstimatesRatePlanSection.swift` (offer card), `cmd/ios-app/PWUsage/Views/Home/RateEstimatesAccessory.swift` and `cmd/ios-app/PWUsage/Navigation/AppTabView.swift` (offer case), the coordinator's `presentedSheet` (`.rateHistory`), `TariffPeriodCardView.swift` (owner plans with `startSource == .urdb` already show `From public utility rates`; confirm, no new copy)

- [ ] **Step 1: Implement** per the approved mockups, with `#Preview`s for each step, the help sheet and the review, using the demo history.
- [ ] **Step 2: Run** `./run-tests.sh` (full) and `./lint.sh` — PASS, zero warnings.
- [ ] **Step 3: Check** in the simulator, light and dark and the largest Dynamic Type, using demo data: every step, Back, Not sure → Still Not Sure, save; screenshot the review step.
- [ ] **Step 4: Commit** `feat(ios): rate plan history guide`.

### Task 11: Live check and PR

- [ ] **Step 1:** On Dev (worktree `.env`, Harrison only), call `GET /api/site/<harrison>/utility/history` through the beta deployment or a local `npm run dev` signed in as the owner; record the years, each year's closest plan and the call time.
- [ ] **Step 2:** Save Option B through 2026-04-27 (all Yes), then confirm the Tesla span starts 2026-04-28 and is current, the saved spans show `startSource: 'urdb'`, `historyGuide` is null, and one re-attribution job ran. Record the results in the PR body.
- [ ] **Step 3:** Push, open a **draft** PR, bind it. The wrap-up gives the worktree path and `open <worktree>/cmd/ios-app/PWUsage.xcodeproj` for on-device checks.

## Follow-ups (not this plan)

- Use the same guide for the reference (fixed) timeline: "Before solar, which plan were you on?"
- Let the guide replace an owner's own plans after confirming.
- Web and TRMNL entry points.
