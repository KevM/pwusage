# Sync to Tesla Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person send the rate plan PWUsage uses today to their Powerwall with one press, a confirmation, and a confirmed result.

**Architecture:** A pure module compares plans semantically and builds and validates Tesla's `tariff_content_v2`. A service provides preview/commit. Preview is read-only and returns a fingerprint. Commit re-checks under the site lock, records an attempt, writes with the pressing member's Tesla client, then reads Tesla back for up to 20 s. The timeline contract gains `syncAvailable`, its reason, and `lastSync`. iOS adds a confirmation sheet launched from the divergence banner and after applying a change to today's plan.

**Tech Stack:** Next.js App Router, TypeScript, `pg`, Vitest. Swift/SwiftUI, Swift Testing.

**Spec:** `docs/superpowers/specs/2026-11-19-sync-rate-plan-to-tesla-design.md`

## Global Constraints

- Only the **actual** plan active today is ever sent. Never the reference (fixed comparison) plan, never history.
- No automatic writes. Only the commit endpoint calls `TeslaClient.setTimeOfUseSettings`.
- The write uses `createTeslaClientForSiteMember(siteId, user.id)`, never the site connection client.
- No network call while holding the `"Site" … FOR UPDATE` row lock.
- Read-back polls for ≤ 20 s. Routes set `maxDuration = 60` (the Vercel Hobby cap; higher fails deploy).
- Rates compare after rounding to 5 decimals. Tesla's adjustments (buy < sell → buy = sell; negative → 0) are applied to PWUsage's side before comparing.
- Payload starts from Tesla's **freshly read** `tariff_content_v2`. Unmodeled fields are kept; `name`, `seasons`, `energy_charges` and `sell_tariff.{seasons,energy_charges}` are replaced. Period labels are only `ON_PEAK`, `PARTIAL_PEAK`, `OFF_PEAK`, `SUPER_OFF_PEAK`.
- Currencies allowed: `USD`, `EUR`, `GBP`.
- The button label is exactly **Sync to Tesla**. Other fixed copy:
  - Effect: "Your Powerwall will start scheduling against these prices. You can change this in the Tesla app at any time."
  - Public plans: "These rates are estimated from public utility rates. Tesla will use them as shown."
  - Confirmed: "Tesla now has this plan."
  - Unconfirmed: "Sent to Tesla. It hasn't confirmed yet; PWUsage will check again."
  - Adjustment line: "Tesla will store {Period} buy as {price} (raised to match the {price} export rate)." / "Tesla will store {Period} {buy|export} as {price} (negative prices become zero)."
  - Post-apply prompt: "Also update your Powerwall?" with **Sync to Tesla** / **Not now**.
- Copy follows `docs/voice-and-terms.md`.
- Migrations only via `npm run db:migration:create <name>` (never hand-named).
- iOS: `./cmd/ios-app/lint.sh` clean, zero compiler warnings, `run-tests.sh --quick` while iterating.
- Contract change and iOS DTO change ship in the same PR.

## Review Focus

1. **Tesla-side adjustment round trip.** A plan with export > import must read as *confirmed* after the write and must not bring the banner back. Pinned in Task 1 (`matches after Tesla raises buy to sell`) and Task 4 (`confirms when Tesla stored adjusted rates`).
2. **Two windows with the same label but different rates in one season.** Must be a listed problem with season and label named, not a silent overwrite. Pinned in Task 2.
3. **Double press / two devices.** Exactly one Tesla write. Pinned in Task 4 (`second commit while sending returns in-flight attempt`).
4. **Our upload imported back must not become the saved Tesla original or move effective periods.** Pinned in Task 4 (postgres test).
5. **Tesla changed between preview and commit** (someone edited in the Tesla app). Must return `conflict` and write nothing. Pinned in Task 4.

---

### Task 1: Semantic plan comparison drives the divergence flag

**Files:**
- Create: `cmd/next-app/src/lib/tesla-tou-sync.ts`, `cmd/next-app/src/lib/tesla-tou-sync.test.ts`
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts:362-364` (`differsFromActiveManual`)

**Interfaces:**
- Produces:
  - `applyTeslaAdjustments(seasons: TariffSeasonInput[]): { seasons: TariffSeasonInput[]; adjustments: TeslaRateAdjustment[] }`
  - `type TeslaRateAdjustment = { season: string; period: TariffPeriodName; side: 'buy' | 'sell'; from: number; to: number; reason: 'raised_to_sell' | 'negative_to_zero' }`
  - `teslaPlansMatch(pwusage: TariffSeasonInput[], tesla: TariffSeasonInput[]): boolean`. Applies adjustments to `pwusage` only; ignores plan and season names; compares month/day ranges, weekday and weekend windows (sorted), labels, and buy/sell rounded to 5 dp.

- [ ] **Step 1: Write failing tests** in `tesla-tou-sync.test.ts`:
  - `matches identical content with different plan and season names` → `true`
  - `matches when rates differ only past 5 decimals` (0.100001 vs 0.1) → `true`
  - `differs on a moved window`, `differs on a changed buy rate`, `differs on a season boundary` → `false`
  - `matches after Tesla raises buy to sell`: pwusage window buy 0.10 / sell 0.12, tesla 0.12/0.12 → `true`
  - `matches after Tesla zeroes a negative price`
  - `applyTeslaAdjustments lists each adjustment` → exact `TeslaRateAdjustment[]`
- [ ] **Step 2:** `npx vitest run src/lib/tesla-tou-sync.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the three exports.
- [ ] **Step 4:** In `tariff-timeline-repo.ts`, replace the `content_hash !==` comparison with `!teslaPlansMatch(decompileTariffToSeasons(activeTariff), decompileTariffToSeasons(latestTeslaTariff))`, using the `tariffMap` entries already loaded. Add a case to `tariff-timeline-repo.test.ts`: `differsFromActiveManual is false when the active plan matches Tesla's content under a different hash`.
- [ ] **Step 5:** Run both test files → PASS. `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(tariffs): compare Tesla and PWUsage plans by content`

### Task 2: Build and validate Tesla's payload

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-tou-sync.ts`, `cmd/next-app/src/lib/tesla-tou-sync.test.ts`
- Test fixture: `cmd/next-app/src/lib/__fixtures__/tesla-tariff-two-season.json`. Use a real-shaped `TariffV2` with `daily_charges` and `demand_charges`; it may sit on the probe's saved shape, scrubbed of site identifiers.

**Interfaces:**
- Consumes: `applyTeslaAdjustments` (Task 1), `parseTariffContent` (`importer/tariff-parser.ts`), `decompileTariffToSeasons`/`compileSeasonsToParsedTariff` (`tariff-timeline.ts`)
- Produces:
  - `type TeslaSyncProblem = { code: 'season_gap' | 'season_overlap' | 'hour_gap' | 'hour_overlap' | 'label_rate_conflict' | 'currency' ; season?: string; period?: TariffPeriodName; message: string }`
  - `validateForTesla(seasons: TariffSeasonInput[], currency: string): TeslaSyncProblem[]`
  - `buildTeslaTariff(base: TariffV2, plan: { name: string; seasons: TariffSeasonInput[] }): TariffV2`

- [ ] **Step 1: Write failing tests:**
  - `round-trips Tesla's own plan`: `teslaPlansMatch(seasonsOf(fixture), seasonsOf(buildTeslaTariff(fixture, {name, seasons: seasonsOf(fixture)})))` → `true`, where `seasonsOf` = parse then decompile
  - `keeps unmodeled fields` → `daily_charges`, `demand_charges`, `utility`, `code`, `currency` deep-equal to the base
  - `sets name and uses only Tesla labels`
  - `keeps five decimals` (0.12345 survives)
  - validation, one test per code: a plan missing December days → `season_gap`; two seasons both covering July → `season_overlap`; weekday 23:00–24:00 uncovered → `hour_gap`; overlapping windows → `hour_overlap`; `label_rate_conflict` names the season and label (`{ code: 'label_rate_conflict', season: 'Summer', period: 'ON_PEAK' }`); currency `CAD` → `currency`
  - `a plan from Tesla, a manual plan and a public plan fixture each validate clean`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Day-of-week numbering and the 24:00 end must invert `parseTariffContent` exactly. The round-trip test is the guard; read the parser rather than guessing.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(tariffs): build and validate Tesla time-of-use payloads`

### Task 3: Sync attempt storage

**Files:**
- Create: migration via `npm run db:migration:create tesla_tariff_sync_attempt`
- Create: `cmd/next-app/src/lib/tesla-tariff-sync-repo.ts`, `cmd/next-app/src/lib/tesla-tariff-sync-repo-postgres.test.ts` (use `createTariffTestDatabase` from `tariff-test-db.ts`, as `tariff-selection-audit-postgres.test.ts` does)

**Interfaces:**
- Produces:
  - Table `"TeslaTariffSyncAttempt"`: `id bigserial`, `site_id text → Site(id) ON DELETE CASCADE`, `user_id text`, `fingerprint text`, `selection_id bigint null`, `replaced_tesla_tariff_id bigint null`, `sent_content jsonb`, `status text CHECK IN ('sending','confirmed','unconfirmed','rejected','failed','not_allowed')`, `tesla_response jsonb null`, `created_at timestamptz default now()`, `finished_at timestamptz null`. Index `(site_id, created_at DESC)`. Unique partial index on `(site_id) WHERE status = 'sending'`: the database enforces one in-flight attempt per site.
  - `type TeslaSyncStatus = 'sending' | 'confirmed' | 'unconfirmed' | 'rejected' | 'failed' | 'not_allowed'`
  - `class TeslaTariffSyncRepo { beginAttempt(client: PoolClient, input): Promise<{ id: number } | { inFlight: TeslaSyncAttempt }>; finishAttempt(id, status, teslaResponse?): Promise<void>; latestForSite(siteId): Promise<TeslaSyncAttempt | null>; settleUnconfirmed(siteId, matches: boolean): Promise<void> }`
  - `beginAttempt` takes the caller's transaction client (called under the Site lock). A `sending` row older than 2 minutes is treated as `failed` and replaced, so a crashed function can't block the site forever.

- [ ] **Step 1: Write failing postgres tests:** `begin returns inFlight while one is sending`, `stale sending row older than 2 minutes is failed and replaced`, `latestForSite returns newest`, `settleUnconfirmed marks confirmed when matches and leaves otherwise`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Write the migration and repo.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(db): record Sync to Tesla attempts`

### Task 4: Preview/commit service

**Files:**
- Create: `cmd/next-app/src/lib/tesla-tariff-sync-service.ts`, `cmd/next-app/src/lib/tesla-tariff-sync-service.test.ts`, `cmd/next-app/src/lib/tesla-tariff-sync-postgres.test.ts`
- Modify: `cmd/next-app/src/lib/tariff-selection.ts` (export `canonicalizeValue`)
- Modify: `cmd/next-app/src/lib/importer/index.ts` (`ensureSite`: after `addTariffVersion`, call `TeslaTariffSyncRepo.settleUnconfirmed(siteId, teslaPlansMatch(active, imported))`)

**Interfaces:**
- Consumes: Tasks 1–3; `createTeslaClientForSiteMember`; `TariffTimelineRepo.getTimeline`; `Importer`; `TeslaAuthError` handling as in `battery-hold-service.ts:144-150`
- Produces:
  - `previewTeslaSync(siteId, userId, deps?): Promise<TeslaSyncPreview>`
  - `type TeslaSyncPreview = { fingerprint: string; current: { name: string; seasons: TariffSeasonInput[] }; proposed: { name: string; seasons: TariffSeasonInput[]; source: TariffSource; selectionId: number | null }; adjustments: TeslaRateAdjustment[]; problems: TeslaSyncProblem[]; estimated: boolean }`
  - `commitTeslaSync(siteId, userId, fingerprint, deps?): Promise<TeslaSyncResult>`
  - `type TeslaSyncResult = { outcome: 'confirmed' | 'unconfirmed' | 'rejected' | 'failed' | 'not_allowed' | 'needs_reauth' | 'conflict' | 'in_flight' | 'unavailable'; message?: string; timeline?: SiteTariffsTimelineResponse }`
  - `class TeslaSyncUnavailableError` carrying `reason: 'no_difference' | 'not_tou_capable' | 'no_tesla_plan' | 'no_active_plan'`
  - `deps`: `{ clientFor(siteId, userId), repo, syncRepo, now(), sleep(ms) }` for tests

Behavior: the fingerprint is SHA-256 of `canonicalizeValue({ version: 1, siteId, selectionId, proposedSeasons, freshTeslaContent, payload })`. Commit flow: fresh `getSiteInfo` → rebuild → fingerprint mismatch → `conflict` → `BEGIN; SELECT … FROM "Site" WHERE id=$1 FOR UPDATE`, re-read the active selection, `beginAttempt`, `COMMIT` → `setTimeOfUseSettings` → poll `getSiteInfo` every 4 s for up to 20 s until `teslaPlansMatch` → `finishAttempt`. On `confirmed`, run `new Importer(client).ensureSite(siteId)` and return the fresh timeline. Error mapping: `TeslaAuthError` 403 → `not_allowed`; other auth/connection errors → `needs_reauth`; a Tesla 4xx with a body → `rejected` with Tesla's message; anything else → `failed`. Problems present → `unavailable` at commit (preview still returns them).

- [ ] **Step 1: Write failing unit tests (fake deps):**
  - `preview returns current, proposed, adjustments, estimated for a public plan`
  - `preview throws unavailable no_difference when plans match`; `not_tou_capable`; `no_tesla_plan`
  - `commit with stale fingerprint returns conflict and never writes` (Tesla content changed after preview)
  - `second commit while sending returns in_flight and never writes`
  - `confirms when read-back matches`; `confirms when Tesla stored adjusted rates`
  - `unconfirmed after 20 s of non-matching read-back` (fake `sleep`, assert ≤ 5 reads)
  - `403 maps to not_allowed`; `Tesla 400 maps to rejected with its message`
  - `uses the pressing member's client` (assert `clientFor` called with `userId`)
- [ ] **Step 2: Write failing postgres test** `tesla-tariff-sync-postgres.test.ts`: with an active manual override and a saved Tesla original, importing the uploaded plan as the new Tesla version leaves the effective periods unchanged and `restore_tesla` candidates still reference the original selection id; `settleUnconfirmed` flips an `unconfirmed` attempt to `confirmed`.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement the service and the importer hook.
- [ ] **Step 5:** Run → PASS. Then `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(tariffs): preview and commit Sync to Tesla`

### Task 5: Routes and contract

**Files:**
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/tesla-sync/preview/route.ts` (+ `route.test.ts`), `cmd/next-app/src/app/api/site/[id]/tariffs/tesla-sync/route.ts` (+ `route.test.ts`)
- Modify: `cmd/next-app/src/lib/tariff-contract.ts` (`teslaSync`), `cmd/next-app/src/lib/tariff-timeline-repo.ts` (populate), `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` (`TeslaSyncDTO`)

**Interfaces:**
- Consumes: Task 4
- Produces:
  - `POST …/tesla-sync/preview` → 200 `TeslaSyncPreview` | 409 `{ error: 'unavailable', reason }` | 401 | 403 cross-origin
  - `POST …/tesla-sync` body `{ fingerprint: string }` → 200 `TeslaSyncResult` (every outcome, including `conflict` and `in_flight`) | 400 bad body | 401
  - `teslaSync` adds `syncAvailable: boolean`, `syncUnavailableReason: 'no_difference' | 'not_tou_capable' | 'no_tesla_plan' | 'no_active_plan' | null`, `lastSync: { status: TeslaSyncStatus; at: string } | null`. `syncAvailable` is computed from DB state only: `differsFromActiveManual` && `Site.json.components.tou_capable` && `Site.json.tariff_content_v2` present.
  - Swift: `TeslaSyncDTO` gains `syncAvailable: Bool`, `syncUnavailableReason: String?`, `lastSync: TeslaSyncAttemptDTO?` (`status: String`, `at: String`)

Route pattern: copy `tariffs/selection/preview/route.ts` (cross-origin check, `getCurrentUser` + `verifySiteAccess`, `observeRoute`, `no-store`). Commit route: `export const maxDuration = 60`, `withIoDeadline(50_000, …)`.

- [ ] **Step 1: Write failing route tests:** auth, cross-origin, bad body, each outcome passes through, `unavailable` → 409 with reason. Add timeline repo tests for `syncAvailable` true/false per reason and `lastSync`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Add an iOS decode test in the existing `MobileTariffs` decoding tests for the new fields.
- [ ] **Step 6: Commit** `feat(api): Sync to Tesla routes and timeline fields`

### Task 6: iOS confirmation and result

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Bill/TeslaSyncModel.swift`, `cmd/ios-app/PWUsage/Views/Bill/TeslaSyncSheet.swift`, `cmd/ios-app/PWUsageTests/TeslaSyncModelTests.swift`
- Modify: `cmd/ios-app/PWUsage/Networking/PWUsageAPI+Tariffs.swift`, `cmd/ios-app/PWUsage/Views/Bill/TariffSheet+Banners.swift`, `cmd/ios-app/PWUsage/Views/Bill/TariffSheet.swift`, `cmd/ios-app/PWUsage/Views/Bill/RatePlanReviewView.swift` (post-apply prompt), `cmd/ios-app/PWUsage/Models/Bill/TeslaDivergenceCopy.swift`

**Interfaces:**
- Consumes: Task 5 endpoints and DTO
- Produces:
  - `PWUsageAPI.previewTeslaSync(siteID:) async throws -> TeslaSyncPreviewDTO`, `commitTeslaSync(siteID:fingerprint:) async throws -> TeslaSyncResultDTO`
  - `@MainActor @Observable final class TeslaSyncModel { enum Phase { case loading, review(TeslaSyncPreviewDTO), unavailable(String), sending, finished(TeslaSyncResultDTO), failed(String) }; func load() async; func confirm() async }`. A `conflict` result reloads the preview and returns to `.review`.
  - `TeslaSyncCopy.resultMessage(_ outcome: String, message: String?) -> String`, using the fixed copy from Global Constraints. `rejected` reads "Tesla didn't accept this plan: {message}. Nothing changed on your Powerwall." `not_allowed` reads "Tesla didn't allow this account to change the Powerwall's rate plan. Nothing changed." `needs_reauth` offers the existing Tesla sign-in path.

Sheet layout: Tesla's current plan beside the plan to send. Reuse the season/window rows from `RatePlanReviewView`. Then the source label, the estimated line when `estimated`, adjustment lines, the effect sentence, and one **Sync to Tesla** button plus Cancel. Problems replace the button with the list of what to fix.

Banner: when `sync.syncAvailable`, add **Sync to Tesla** (`.borderedProminent`) beside the existing pull button. **Rename the existing pull button "Sync" → "Check Tesla"**, so the two can't be confused (pending owner OK; see handoff). After `RatePlanReviewView` applies a change with `scope == actual` covering today, and the refreshed timeline has `syncAvailable`, show the "Also update your Powerwall?" prompt. **Sync to Tesla** opens the sheet; **Not now** dismisses.

- [ ] **Step 1: Write failing model tests** (stub API): `load shows review`, `load shows unavailable reason`, `confirm confirmed shows Tesla now has this plan`, `confirm unconfirmed message`, `conflict reloads preview`, `rejected message includes Tesla's text`, `double confirm sends once` (second call ignored while `.sending`).
- [ ] **Step 2:** `./cmd/ios-app/run-tests.sh --quick` → FAIL.
- [ ] **Step 3:** Implement the model, API, copy, sheet, banner and prompt.
- [ ] **Step 4:** `./cmd/ios-app/run-tests.sh --quick` → PASS; `./cmd/ios-app/lint.sh` clean; build with zero warnings.
- [ ] **Step 5:** Simulator check: light/dark, largest Dynamic Type, VoiceOver labels on both banner buttons.
- [ ] **Step 6: Commit** `feat(ios): Sync to Tesla confirmation`

### Task 7: Docs, full verification, live check

**Files:**
- Modify: `docs/tesla-tou-write-probe.md` ("If we build it" → points to the spec), `TODO.md` (remove both "Send a custom rate plan" and "Publish a verified plan to the Powerwall" entries; add any deferred items, such as web UI), `docs/voice-and-terms.md` (add **Sync to Tesla** / **Check Tesla** if the word list covers buttons)

- [ ] **Step 1:** `cd cmd/next-app && npm run lint && npm run typecheck && npx vitest run && npm run build` → all clean.
- [ ] **Step 2:** `./cmd/ios-app/run-tests.sh` (default mode) → PASS.
- [ ] **Step 3: Live check** on the Harrison Dev-linked site (Dev DB, never Prod tokens). Set a manual plan differing by one rate, preview, commit, expect `confirmed` and the banner cleared. Then Restore Original Tesla Rate Plan and sync again, and confirm with the probe's read-only run that Tesla holds the original.
- [ ] **Step 4: Commit** `docs: Sync to Tesla shipped; update probe notes and TODO`
