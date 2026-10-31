# SDD ledger — plan: docs/superpowers/plans/2026-10-30-on-device-solar-layout.md

Scope this run: Phase B (Task 6) only, per owner. Phase C waits on owner's iPhone timing check.
Phase A ledger (Tasks 1–5 complete, PR #261 merged) lives in the on-device-solar-layout worktree; its rulings and parked minors stand.
Spec: none separate; plan's "Design decisions" is the agreed design. Rulings provisional against it.
Models: Haiku implements, Sonnet reviews, Opus final review.
Branch: feat/solar-history-endpoint from origin/main 94cc4bfa.
Dev DB = Supabase project aipxozppjmijrpwyuvuo (has pwusage_env marker). Dev slice: 196 rows, all grid axis, status non-null, fetched_at non-null, avg payload 1.9 KB.

## Pre-flight scan

| Rows | Produces / consumes | Finding |
|---|---|---|
| T6 → T7 | `changedSince` strict on fetched_at; stable paging for fixed changedSince; nextFrom = day after last returned | consistent with Task 7 watermark rule; tests must pin both (owner) |
| T6 self | plan files list only store + route, but "decode only solar channel" needs a codec helper | Ruling: add `decodeDaySolar` to compact-energy.ts (same integrity checks, reads only solar column) — cost: one extra file touched |
| T6 self | interface `samples:{timestamp,solarWh}[]` vs response slots | consistent: route maps samples to slots by (t - dayStart)/5min |
| T6 self | off-grid ('offsets' axis) samples have no slot | Ruling: only exact 5-min grid samples fill a slot; off-grid dropped (null). Dev has none — cost: rare offsets days lose samples |
| T6 self | DB status nullable but response type is non-null | Ruling: SQL returns only rows with status IS NOT NULL (legacy null-status rows are skipped). Dev has none — cost: legacy days absent from history |
| T6 self | "from … otherwise 400" | Ruling: HTTP 400 when from < site-local today − 400 days, malformed from, or malformed changedSince; from exactly 400 back OK; from after today → empty days, nextFrom null |
| T6 self | page size detection | Ruling: route asks store for limit 93, returns 92, nextFrom from 92nd day |
| T6 self | value transform | Ruling: solarWh = round(solar_power*10)/10, no clamping (cron hands detector raw solar_power) |
| T6 self | Step 5 egress needs Dev DB access from worktree; .env copy denied by permissions | Ruling: controller measures via Supabase MCP (read-only SQL sizing selected columns on Dev), extrapolates to a year — cost: estimate, not socket count |
| T6 self | store tests need real PG | runs via `npm run test:compact -- <file>` (local PG 17 socket); plain npm test skips them |
Task 6: base 94cc4bfa, implementer Haiku dispatched
Egress (Dev, Harrison 2252268092126997, read-only sizing): 45 days → selected columns 88,045 B (~1.96 KB/day) vs full rows 123,112 B. Year first sync ≈ 715 KB column bytes (~1.4 MB on wire if bytea goes hex in pg text protocol). Incremental syncs: a few days.
Task 6: implementer done, commit blocked by 1Password signing (staged). Review on staged diff.
Task 6: committed c93ab962 (controller, after owner unlocked 1Password); staged diff under review == commit 94cc4bfa..c93ab962
Task 6: review Approved (Sonnet), no Critical/Important. ⚠️ solar column offset +8 verified by controller (sampleColumns[1]=solar_power).
Task 6: minor (deferred): integrity failure on one day → whole page 500 (fails closed; sync retries same day)
Task 6: minor (deferred): non-empty row with null payload yields [] silently behind codec!/axis!/checksum!
Task 6: minor (deferred): NaN test offset hardcoded +8; Identity type unused by decodeDaySamples; decodeDaySolar maps twice; status-null test drops CHECK constraint; vi.setSystemTime not restored; changedSince with '+hh:mm' must be percent-encoded (server emits Z)
Task 6: complete (commits 94cc4bfa..c93ab962, review clean)
Egress: one Harrison Dev day (2026-10-29): payload 1,818 B → response day JSON 895 B (315 B gzip). Year response ≈ 330–480 KB JSON (~120 KB gzip). DB side ≈ 715 KB column bytes/year, ~1.4 MB on wire (pg text-mode bytea is hex).
Final review (Opus): Ready. Important I1 — watermark at newest fetchedAt can permanently miss days (fetched_at = Tesla request start, writers commit out of order; mid-sync rewrites; ms ties). Ruling: server contract stands; Task 7 watermark rule amended in the plan to max(fetchedAt) − 5 min with upsert by dayStart, plus a route JSDoc note — controller made these doc-only edits directly — cost if wrong: phone re-downloads ≤5 min of rewrites per sync (harmless) or, if a writer exceeds 5 min (local tsx backfill), a manual full resync.
Final review minors: M2 day label uses current tz (Task 7 keys by dayStart — in plan); M3 400-day bound in site tz (in plan); M4 93rd row decoded needlessly (parked — Ruling: cheap, not worth complexity). All deferred minors triaged non-blocking.
Verification: lint 0 errors (1 pre-existing warning), build ok, npm test 1791 passed, PG suites 78/78.
Phase B: complete. PR https://github.com/KevM/pwusage/pull/263 (Auto-fix on). Workspace kept for Phase C (Task 7 must use the amended watermark rule).
Owner device check (2026-10-31): iPhone, Debug+SWIFT_OPTIMIZATION_LEVEL=-O, year parity passed — south-clipped-year 3.66 s, both fixtures 7.375 s total (~3.7 s each). Phase C unblocked; one year's detection fits a BGProcessingTask easily.

## Phase C — Task 7 (in progress)

Implementer: Codex subagent, branch `codex/solar-layout-phase-c`, base `afc93e21`.

Implemented mobile history response decoding and `/api/mobile/solar-history` API request, plus actor-backed `SolarHistoryStore` with hashed account/site files, 365-day initial range, paging with a fixed changedSince watermark, upsert by dayStart, `max(fetchedAt) - 5m` advancement on completed paging, 400-day pruning, disabled clear, hourly aggregation, and removal APIs. Added initial focused tests for page/watermark and first range. SwiftFormat ran; SwiftLint has no error diagnostics (cache persistence emits a sandbox warning).

Verification: initial sandbox test runner could not connect to CoreSimulatorService; rerun with approved simulator access compiled successfully. `First request begins 365 days before now` passes. `Pages use the same watermark and apply the five minute lag` currently fails: observed 4 fake requests and no stored samples, so fixture sequencing/behavior needs diagnosis before this task is complete. No commit yet. Other requested coverage (interrupted first sync, incremental rewrite, prune, disabled clears, hourly parity/DST, sign-out cleanup, dayStart identity) remains to add.

### Task 7 static review update

Aligned Task 9-facing interfaces: `MobileSolarHistoryResponse.enabled(timeZone: TimeZone, ...)`, standalone `SolarHistorySyncResult.synced(timeZone: TimeZone)`, valid-sample tuples `(timestamp, solarWh)` with nullable slots omitted, and site-local `lastDay` string. Initial UTC discovery request is UTC today minus 364 calendar days; after receiving the server zone, the store restarts the first sync at the exact site-local today-minus-365 boundary. Incremental scans start at the earliest retained day and always carry the persisted watermark.

Fixed pagination exit (`break syncPages`), site-midnight 400-day pruning, and sync invalidation generations: overlapping scope syncs, `remove(scope:)`, and `removeAll()` invalidate stale responses; generation is checked after each awaited page and before persistence. Added deterministic suspended-request sign-out race coverage. Targeted suite passed 10/10 before interface changes. Later retry could compile the app but simulator service was updating; owner confirmed the simulator runtime is downloading a new version and instructed no further tests until it settles. Latest SwiftFormat and strict SwiftLint are clean. No commit per owner instruction; rerun targeted and full suite when runtime download completes.
Task 7 static fix round: used site-local midnight before subtracting 400 calendar days; added per-scope and global generation epochs checked after every page await and before save, invalidated by sync/remove/removeAll; added a continuation-based test proving sign-out cannot be undone by an in-flight response. Corrected the DST test bootstrap fixture to return the site zone. Latest format and strict lint are clean. Runtime tests remain paused until the owner confirms the simulator download is settled. No commit.
Reviewer fix round 2: history decoding now accepts finite negative solar values (hourly aggregation flags them invalid); incremental queries begin at the inclusive site-local 400-day floor to catch older backfills while respecting the server bound; pruning uses that same local-day boundary. Expanded hourly cases for missing, negative, zero, interval boundary, and fall-back repeated UTC hours; spring 276-slot and fall 300-slot day fixtures. Static `swiftc -frontend -parse` passed all touched Swift files; format and strict lint are clean. Simulator tests remain paused.

Task 7 review fix round 4: wired injectable shared SolarHistoryStore into SolarForecastStoreSessionCleanup, which runs for logout and session invalidation and attempts history cleanup even if another cleanup fails. The existing generation fence blocks suspended sync responses after removal. A real MobileAuthService session invalidation test now checks persisted history removal and the in-flight race. Incremental requests start at site-local today minus 399 days, allowing one day of server clock or midnight skew; pruning remains 400 days. Tests cover the skew boundary and updated paging expectations. SwiftFormat ran; strict SwiftLint has zero violations. Targeted SolarHistoryStoreTests passed 17/17; compiler emitted warnings in unrelated existing forecast tests and fixture loader, with none in the changed history files. Full default suite running. No commit.

Task 7 review fix round 5: incremental scan now starts at the inclusive 400-day boundary to catch retained-day rewrites. If and only if the first incremental request returns HTTP 400, it retries today minus 399 days with the same watermark; no page data has been applied at that point. Tests verify a day-400 rewrite and a rejected-boundary retry. Addressed existing compiler warnings narrowly: discardable connect result, local formatter inside Sendable decoder closure, unnecessary await, and a Swift Testing macro unused-result warning. SwiftFormat and strict SwiftLint passed; updated targeted suite passed 17/17 with no compiler warnings. Earlier full suite passed 866/866 before round 5; updated full suite is running. No commit.

## Phase C — Task 8

Implemented `SolarLayoutRecordStore` with SHA256-scoped Application Support records, coordinate rounding before persistence, source-insensitive same-coordinate result preservation, result-location/detector-version provenance, response-state mapping, and complete file protection/excluded-backup attributes. Wired its `removeAll()` into the injected session cleanup used by logout and session invalidation; the existing `MobileAuthService` invalidation test now verifies both layout and history files are removed. Focused suite passed 5/5. Full default run passed 878 Swift Testing cases across 78 suites (runner reports 871 XCTest wrapper tests); no compiler warning/error diagnostics. Exact SwiftFormat lint, strict SwiftLint (0 violations), and `git diff --check` passed. The first post-refinement build exposed helper visibility; moved coordinate comparison to a file-private function, then targeted and full runs passed. Commit pending.

Task 8 review round: response tests now cover absent local record, location-only pending, medium confidence, and unchanged record/file bytes on stale save; a signed follow-up commit is present. Persistence update clears `attemptedAt` on a coordinate move. Atomic writes now request both `.atomic` and `.completeFileProtection`, while cache updates immediately after committed replacement to keep memory aligned if later metadata calls fail. An injected `FileManager` failure test verifies disk/cache consistency. Simulator `attributesOfItem` returns no `.protectionKey` after a protected write, so a brittle protection attribute assertion is omitted; the supported `Data.WritingOptions.completeFileProtection` write option remains the protection guarantee, and the existing post-write metadata call remains for platform filesystems that expose it. Scope-isolation test verifies separate hashed files.

Round 5 final verification: updated full default suite passed (866 executed; Swift Testing reports 873 tests in 77 suites), with zero warning or error lines in `/private/tmp/task7-full2.log`. Targeted suite passed 17/17 and strict SwiftLint reported zero violations. No commit.

Pre-commit: simplified multiline test fixtures to satisfy both formatter and SwiftLint, renamed test support to kebab-case. `swiftformat --lint`, strict SwiftLint, and `git diff --check` passed; targeted tests passed 17/17 with no warnings. Signed commit 099fb17e (`feat(ios): cache solar day history on device`); SSH signature is present, although local verification cannot report trusted status without an allowed signers file.
