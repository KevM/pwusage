# Rate Plan Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let people inspect and override automatically selected rate plans, review explicitly dated changes, verify their details, and restore saved Tesla versions, with public plans gated to US sites.

**Architecture:** Extend append-only tariff versions and the existing actual/reference effective timelines. Separate immutable source from protected user selections and range-bound verification; preview and commit share a comparison builder and conflict check. Derive country from existing on-device site location where possible and send country metadata, not coordinates, to the server.

**Tech Stack:** TypeScript, existing PostgreSQL repositories, Vitest, Swift/SwiftUI, Swift Testing, existing local/private-iCloud solar records.

---

Approved requirements and copy: [design](2026-11-17-rate-plan-selection-design.md).
This plan is not an implementation or a claim that tests have run.

## Preparation

1. Read root and both app `AGENTS.md` files, `TODO.md`,
   `DesignDecisions.md` (append-only tariffs), `Authentication.md`, and
   `docs/voice-and-terms.md`.
2. Start an isolated implementation checkout from the intended target branch.
   The documentation PR is based on `main`; do not carry unrelated CI or
   dependency changes into implementation. Do not include untracked root
   `node_modules/` in commits.
3. Track the implementation milestones in `task.md`. Use
   @superpowers:test-driven-development for implementation and the repository
   Swift craft, concurrency, SwiftUI, and testing skills for their domains.
   Fetch Context7 documentation when using new library APIs; source-code-only
   business rules do not require external documentation.
4. Implement tasks sequentially unless independent work is explicitly delegated.

## Task 1: Build the review model and compare affected intervals

**Files:**
- Create: `cmd/next-app/src/lib/tariff-selection.ts`
- Create: `cmd/next-app/src/lib/tariff-selection.test.ts`
- Modify: `cmd/next-app/src/lib/tariff-contract.ts`
- Reuse: `cmd/next-app/src/lib/tariff-timeline.ts`

1. Add failing tests for backdated replacements across two plans and a gap,
   inclusive end dates, ongoing ranges, and unchanged outside periods.
2. Run from `cmd/next-app`:
   `npm test -- --run src/lib/tariff-selection.test.ts`. Confirm the intended
   missing comparison behavior fails before implementing it.
3. Implement pure review types and interval planning. The input must explicitly
   provide `effectiveFrom` and either an end date or ongoing intent. Never fill
   absent dates from today, a public revision date, or the Tesla import date.
   Split comparisons at date, season, and time boundaries. Carry complete old
   and new plans, buy/sell schedules, currency, gaps, and approximation notes.
4. Add the following distinctions to the contract, preserving existing wire
   values for source:

   ```ts
   type TariffSelectionScope = 'actual' | 'reference';
   type TariffSelectionCandidate =
     | { kind: 'public'; label: string }
     | { kind: 'manual'; name: string; seasons: TariffSeasonInput[] }
     | { kind: 'restore_tesla'; originalSelectionId: number };
   interface TariffSelectionRequest {
     scope: TariffSelectionScope;
     candidate: TariffSelectionCandidate;
     effectiveFrom: string;
     effectiveTo: string | null;
   }
   interface TariffSelectionCommit extends TariffSelectionRequest {
     expectedReviewHash: string;
     verifiedAgainstBill: boolean;
   }
   ```

   Define the preview response around `reviewHash`, affected intervals with
   before/after details, and restoration provenance. Do not make the client
   invent published rates or assert a stored tariff belongs to another site.
5. Cover missing dates, different period names with identical rates, identical
   names with different rates, and export-price differences. Rerun the suite
   and existing `tariff-timeline.test.ts`. Commit the model and contract.

## Task 2: Persist source, protected selections, and exact verification

**Files:**
- Generate migration under `cmd/next-app/db-migrations/` using
  `npm run db:migration:create tariff_selection_provenance`.
- Modify: `cmd/next-app/src/lib/db-types.ts`
- Modify: `cmd/next-app/src/lib/tariff-estimates.ts`
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts`
- Modify: `cmd/next-app/src/lib/tariff-repo.ts`
- Modify: `cmd/next-app/src/lib/urdb/estimate-job.ts`
- Test: `cmd/next-app/src/lib/tariff-estimates.test.ts`
- Test: `cmd/next-app/src/lib/tariff-timeline-repo-postgres.test.ts`

1. Add failing behavior tests: a public plan selected by an owner survives an
   estimate rebuild and a new Tesla import; reference selections are equally
   protected. Capture originals even if their effective rows disappear.
2. Run the focused Vitest suite; run PostgreSQL tests through the existing
   compact-history harness and its documented development-database guard.
3. Generate a migration, with RLS and grants for all new tables/sequences.
   Use immutable selection records referencing tariff versions, scope, dates,
   chooser, choice kind, and original Tesla versions per replaced interval.
   Effective periods reference their selection. Bind verification to the
   selected tariff hash and exact range, verifier, and timestamp.
4. Backfill existing explicit owner periods as protected/unverified. Keep
   source values `tesla`, `manual`, and `estimated`; automatic layout must
   preserve owner-selected estimated rows. Splits must retain provenance and
   only display verification where its content/range still applies. Protect
   public source records from `estimate-job.ts`'s current blanket source
   replacement. Preserve append-only tariff identities and historical lookup.
5. Update import/layout precedence so background activity cannot replace
   explicit selections, including restored saved Tesla selections. Reuse
   existing overlap mutation and reattribution queues.
6. Verify content/date changes invalidate verification, unchanged saves do not
   manufacture versions, and older original versions remain restorable after
   later Tesla imports. Verify the migration is idempotent on a guarded dev DB.
   Commit the schema and persistence changes.

## Task 3: Add shared preview/commit APIs and public-plan details

**Files:**
- Create: `cmd/next-app/src/lib/tariff-selection-service.ts`
- Create: `cmd/next-app/src/lib/tariff-selection-service.test.ts`
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/selection/preview/route.ts`
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/selection/route.ts`
- Create matching `route.test.ts` files beside both routes.
- Modify: `cmd/next-app/src/app/api/site/[id]/utility/plans/route.ts`
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts`
- Reuse: `cmd/next-app/src/lib/urdb/convert.ts`

1. Write failing route/service tests for access isolation, an explicit public
   plan replacing Tesla, restoration, and a stale comparison conflict.
2. Run the new route/service test paths with `npm test -- --run`.
3. Implement preview resolution outside the database lock. Public browsing
   must support the chosen effective date and expose complete convertible rate
   details, not just today's name/label list. Explain tier blending and
   fallback export values in returned provenance. Reuse the existing converter
   and supported-plan validation; reject unsupported/currency-incompatible
   candidates rather than silently transforming them into another product.
4. Produce a deterministic review hash covering the canonical request,
   candidate content, relevant existing periods, original versions, conversion
   inputs, and eligibility. Commit revalidates that hash under the site lock
   using the same comparison code. No remote requests inside the transaction.
   Return 409 with a refresh path on conflict, not a silent rebase of the edit.
5. Apply selected intervals and verification and enqueue actual-plan repricing
   in one transaction. Restore references saved original versions, never
   whichever Tesla version happens to be newest. Reference-only changes leave
   actual attribution untouched. Make retries idempotent without replaying an
   old review against a changed timeline.
6. Test finite/open ranges, missing dates, changed public data, duplicate
   submissions, no Tesla original, multiple original versions, malformed
   candidates, unauthorized IDs, and transaction rollback. Preserve legacy
   routes for old clients, ensuring none bypass selection protection.
   Rerun focused suites and commit.

## Task 4: Enforce US eligibility server-side

**Files:**
- Generate migration with `npm run db:migration:create site_rate_country`.
- Create: `cmd/next-app/src/lib/rate-plan-eligibility.ts` and its `.test.ts`.
- Create: `cmd/next-app/src/app/api/site/[id]/rate-country/route.ts` and its `.test.ts`.
- Modify: `cmd/next-app/src/lib/tariff-contract.ts`
- Modify: `cmd/next-app/src/lib/urdb/estimate-job.ts`
- Modify: all four utility routes under `cmd/next-app/src/app/api/site/[id]/utility/`.
- Modify: `cmd/next-app/src/lib/tariff-selection-service.ts`
- Test: `cmd/next-app/src/lib/urdb/estimate-job.test.ts`
- Test: `cmd/next-app/src/app/api/site/[id]/utility/routes.test.ts`

1. Add failing tests proving outside-US and unknown sites cause no public API
   calls, and manual/Tesla operations remain available.
2. Run focused eligibility, utility-route, and estimate-job tests.
3. Store a validated country code with provenance (`solar_location` or
   `owner`), update time, and derived eligibility. Explicit owner correction
   wins over inference. Reject coordinates in the country endpoint payload.
   Treat unknown as distinct from opt-out and from failed/running processing.
4. Gate cron, searches, utility/plan selection, candidate details, preview,
   and commit consistently. Expose additive eligibility metadata to clients.
   Existing unresolved sites need country confirmation, not a US utility
   search. Stop repeated doomed public lookups for outside-US sites.
5. Cover changed eligibility during review, invalid codes, owner precedence,
   clearing stale inference, existing automatic public coverage removal with
   repricing, and preservation/review of explicit historical choices. Commit.

## Task 5: Mirror contracts and resolve country from saved site location

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/SiteRateEstimatesDTO.swift`
- Modify: `cmd/ios-app/PWUsage/Networking/PWUsageAPI+Tariffs.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Tariffs.swift`
- Create: `cmd/ios-app/PWUsage/Models/Bill/RatePlanSelection.swift`
- Create: `cmd/ios-app/PWUsage/State/Solar/SiteCountryResolver.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+HomeLocation.swift`
- Test: `cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests.swift`
- Create: `cmd/ios-app/PWUsageTests/SiteCountryResolverTests.swift`

1. Write failing decoding and resolver tests for absent new fields, saved site
   location, outside-US results, border uncertainty, and missing location.
2. Run targeted suites through `./cmd/ios-app/run-tests.sh --quick` from root.
3. Add matching Sendable contracts and API methods. Keep scope account/site
   bound; discard completions after a site/account/location generation changes.
4. Research and record the country-resolution provider or boundary-data choice
   before implementation. Prefer existing saved site coordinates, not the
   phone's current position. Use maintained boundaries and an uncertainty
   margin for rounding near borders; never use a US bounding box. For an
   external provider, verify and disclose where coordinates go before use.
   Send only the country result/provenance to PWUsage and persist no new raw
   coordinates. A failed resolution must not erase an explicit country choice.
5. Add a manual country correction path for missing/uncertain results. Test
   account isolation and stale completion cancellation. Run lint and targeted
   suites, then commit.

## Task 6: Implement selection and mandatory-date review UX

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/Bill/TariffSheet.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/RateEstimatesRatePlanSection.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/TariffPeriodCardView.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/ActiveRatePlanCardView.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/RatePlanEditorFlow.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/RatePlanDateField.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/RatePlansSheet.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/UtilityPlanPickerView.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RatePlanDraft.swift`
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RatePlanEditorState.swift`
- Create: `cmd/ios-app/PWUsage/Views/Bill/RatePlanReviewView.swift`
- Create: `cmd/ios-app/PWUsage/Models/Bill/RatePlanReviewModel.swift`
- Create: `cmd/ios-app/PWUsageTests/RatePlanReviewModelTests.swift`
- Extend existing draft, editor-flow, and tariff-sheet tests.

1. Write failing state tests: an unset date disables review; editing invalidates
   review; unchecking verification does not imply it; cancel leaves state
   unchanged; a 409 returns to refreshed review, not automatic application.
2. Run focused native suites. Implement a draft start date as an optional,
   initially nil value. Opening a date picker must not itself count as choosing
   a date. Require an explicit ongoing/end choice. Keep copied plan rates but
   never silently copy effective dates into a new override/restoration.
3. Keep Change Plan available in ready and override states. Show source and
   chooser separately from verification. Use the exact approved public source
   and restoration labels. Show actual and fixed comparison scopes clearly.
4. Route public selection, manual entry/edit, and saved-original restoration
   through the same server preview and review model. Render all affected
   before/after intervals with usage and production rates. Require review
   acknowledgement; bill verification is a separate unchecked option. Show
   the PWUsage-only warning, background repricing progress, and retry states.
5. Preserve the existing form validation and unsupported-plan explanations.
   Handle older servers by hiding unsupported mutation actions, while still
   displaying existing plans. Do not break older clients' additive decoding.
6. Review previews and a running flow at narrow widths, large Dynamic Type,
   VoiceOver, and light/dark appearance. Test the full backdated multi-plan
   example, then restoration and a later Tesla sync. Run lint and targeted
   tests, then commit.

## Task 7: Warnings, wording, and complete verification

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RateEstimatesPresentation.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/TariffSheet+Banners.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/UtilityPickerView.swift`
- Modify: `cmd/next-app/src/app/privacy/page.tsx`
- Modify: `docs/voice-and-terms.md`
- Modify: `DesignDecisions.md` with a link to the selection rationale.
- Update `TODO.md` with the explicitly deferred Powerwall publishing work.
- Extend: `cmd/ios-app/PWUsageTests/RateEstimatesPresentationTests.swift`

1. Test and implement separate notices for observed Tesla/PWUsage mismatch,
   newer public revision, and aging public estimates. Include the observation
   time when discussing the plan last read from Tesla. No warning changes a
   plan automatically and no UI implies a successful Powerwall update.
2. Document source labels and update privacy/utility-picker wording for local
   country inference and country-only reporting. Do not duplicate this design
   into app guides. Add implementation-specific invariants where they belong.
3. From `cmd/next-app`, run in order: `npm run lint`, `npm run typecheck`,
   `npm test -- --run`, `npm run build`. Also run changed PostgreSQL suites
   using the guarded development database harness. Confirm migration replay.
4. From root, run `./cmd/ios-app/lint.sh` and
   `./cmd/ios-app/run-tests.sh` (default suites). Do not substitute direct
   xcodebuild commands or skip required tests because a quick suite passed.
5. Verify complete flows: automatic match → public override → bill verification
   → Tesla import → original restoration; manual backdated replacement across
   several versions; independent reference replacement; international site;
   missing country with/without saved location; stale review; failed/retried
   repricing. Confirm only reviewed dates change and no Powerwall write occurs.
6. Commit verified changes and open a draft PR. Report actual checks and any
   remaining limitations. Keep Tesla writeback out of this implementation.

## Deferred work

Powerwall publishing requires separate API research and a new design for fresh
authorization, explicit behavioral confirmation, exact verified-content checks,
readback, uncertain results, and rollback/recovery. A verified plan is not
authorization to send a Tesla command.
