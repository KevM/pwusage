# Site history onboarding

Approved design: docs/plans/2026-11-02-history-onboarding-design.md
Implementation plan: docs/plans/2026-11-02-history-onboarding.md

- [x] Bounded fill on `POST /api/mobile/solar-history` (separate history-backfill endpoint removed), Tesla throttle surfaced as 529 + `Retry-After`.
- [x] Detector readiness (`SolarLayoutDetector.readiness`, the producing-day gate on the samples, no fit) and typed `shortfall` + `historyOutlook` feedback.
- [x] On-device job (`SiteHistoryOnboarding`): persisted cursor, retry/backoff, account Tesla throttle, checkpoint decisions; fill API, history merge, forced detection.
- [ ] Integrate foreground and existing background lifecycle.
- [ ] Add Settings history details and temporary tab accessory.
- [ ] Add reversible Dev setup/restore scripts and device reset.
- [ ] Run required iOS/server verification and commit verified changes.

Current state: server fill contract is implemented and tested (see "Implemented fill contract" in the design). Client integration has not started; next is lifecycle integration (Task 4): construct `SiteHistoryOnboarding` with `LiveSiteHistoryOnboardingEnvironment`, run it on foreground and background opportunities, resume after Tesla reconnect, remove account state on sign-out.
