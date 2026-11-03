# Site history onboarding

Approved design: docs/plans/2026-11-02-history-onboarding-design.md
Implementation plan: docs/plans/2026-11-02-history-onboarding.md

- [x] Bounded fill on `POST /api/mobile/solar-history` (separate history-backfill endpoint removed), Tesla throttle surfaced as 529 + `Retry-After`.
- [x] Detector readiness (`SolarLayoutDetector.readiness`, the producing-day gate on the samples, no fit) and typed `shortfall` + `historyOutlook` feedback.
- [x] On-device job (`SiteHistoryOnboarding`): persisted cursor, retry/backoff, account Tesla throttle, checkpoint decisions; fill API, history merge, forced detection.
- [x] Integrate foreground and background lifecycle (`SiteHistoryOnboardingLifecycle`, `BackgroundSiteHistoryOnboarding` processing task, resume on sign-in/reconnect, cleanup on sign-out).
- [x] Add Settings history details and tab accessory (`SiteHistoryView`, `SiteHistoryPresentation`, iOS 26.1 `tabViewBottomAccessory`).
- [ ] Add reversible Dev setup/restore scripts and device reset.
- [ ] Run required iOS/server verification and commit verified changes.

Current state: server fill, readiness, the on-device job, its lifecycle and the Settings/tab-accessory UI are implemented and tested (see the "Implemented …" sections in the design). Next is Task 7 (reversible Dev setup/restore scripts and a Debug device reset), then Task 6's end-to-end checks on a real site.
