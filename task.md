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
