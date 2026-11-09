# Site history onboarding

Approved design: docs/plans/2026-11-02-history-onboarding-design.md
Implementation plan: docs/plans/2026-11-02-history-onboarding.md

- [x] Bounded fill on `POST /api/mobile/solar-history` (separate history-backfill endpoint removed), Tesla throttle surfaced as 529 + `Retry-After`.
- [x] Detector readiness (`SolarLayoutDetector.readiness`, the producing-day gate on the samples, no fit) and typed `shortfall` + `historyOutlook` feedback.
- [x] On-device job (`SiteHistoryOnboarding`): persisted cursor, retry/backoff, account Tesla throttle, checkpoint decisions; fill API, history merge, forced detection.
- [x] Integrate foreground and background lifecycle (`SiteHistoryOnboardingLifecycle`, `BackgroundSiteHistoryOnboarding` processing task, resume on sign-in/reconnect, cleanup on sign-out).
- [x] Add Settings history details and tab accessory (`SiteHistoryView`, `SiteHistoryPresentation`, iOS 26.1 `tabViewBottomAccessory`).
- [x] Add reversible Dev setup/restore scripts and device reset (`scripts/dev-history-reset.sh`, `dev-history-restore.sh`, Debug Site History section).
- [ ] Run required iOS/server verification and commit verified changes.

Current state: everything through Task 7 is implemented and tested. Remaining: Task 6, the real-device run on Beta/Dev following `cmd/next-app/scripts/dev-history-reset.md` (needs this branch's server deployed to Beta, which the PR preview provides).

# Solar System experience

Plan: docs/plans/2026-11-02-solar-system-experience.md

- [x] Clear-day pass (`SolarLayoutDetector.classifyDays`, parity with `detect`, Debug timing).
- [x] Day ledger and checkpoint record per site (cleared on sign-out and Debug reset).
- [x] Onboarding cadence and stop rules: pass every second slice, full detection on 15/40 clear or 180 producing, continue to high confidence.
- [x] Status model and presentation phases; counts from the phone's history, not the onboarding position.
- [x] Pure geometry: strip layout, wedge, hip roof, projection.
- [x] Solar System screen (merges Site History and Solar Forecast; credit moves to About).
- [x] Banner: compass, day dots, needs-location state.
- [x] Home location sheet: current location (one-time), address or ZIP search, map pin.
- [x] Verification: suites, lint, Release build, simulator states (loading, waiting, needs location, improving, final; light/dark, AX text, Reduce Motion, location sheet search and map).

Current state: Tasks 1–9 are implemented and verified on the simulator. Remaining for the user: the real-device run on Beta (`cmd/next-app/scripts/dev-history-reset.md`), including the clear-day pass's Debug timing on an iPhone 18 Pro and the oldest phone available; the cadence stays every second slice until those numbers say otherwise.

# Shared site membership (2026-11-08)

Design: docs/superpowers/specs/2026-11-08-shared-site-membership-design.md
Branch: codex/shared-site-membership

- [x] Create and locally rerun the membership schema migration.
- [x] Add a physical-hardware Battery Saver start lease and reject starts while another row has an active hold.
- [x] Resolve `/profile` from the signed-in account.
- [x] Pin site clients to their selected account; reconcile stale site rows after a successful Tesla product list; keep new hardware IDs; guard reserve settle across duplicate rows; retire expired holds only when nobody can restore; add disposable PostgreSQL regression tests.
- [x] Attribute TRMNL installs to the signed-in installer and sync webhook email only to that account.
- [ ] Finish Phase 1: shared-safe account deletion (PR #319 is still documentation-only), fuller PostgreSQL coverage, remaining identity fixes.
- [x] Phase 2 core: pinned site clients translate all five Tesla site calls from `Site.id` to the member's fresh Tesla ID; missing mappings fail before a request. Legacy product-list access maps IDs back to pwusage sites. Disposable PostgreSQL and web tests cover re-invites and endpoint URLs.
- [ ] Finish Phase 2: remove unused site-scoped refresh helpers. The script audit found one raw `calendar_history` call in `check-soe-history.ts`; it now reads the mapped ID from the pinned request credentials.
- [ ] Phase 3: flag added off by default; site-list, Live Activity, admin user, and solar beta reads use members when enabled. Verification probes a member's own grant. Broken connection repair, login join/re-invite, conditional removal, and daily reconciliation are implemented with unit and disposable PostgreSQL tests. Command routing, dead-grant cleanup, outage reach-back, and remaining authorization still need implementation. Do not enable the flag yet.
- [ ] Phases 4–5: product and iOS states, merge tool, rollout and documentation.

U2: The owner confirmed on 2026-11-08 that invited accounts can change the reserve with their own Tesla grant. This session did not rerun the beta script.
