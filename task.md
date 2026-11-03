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
- [ ] Solar System screen (merges Site History and Solar Forecast; credit moves to About).
- [ ] Banner: compass, day dots, needs-location state.
- [ ] Home location sheet: current location (one-time), address or ZIP search, map pin.
- [ ] Verification: suites, lint, Release build, simulator states, device run on Beta.
