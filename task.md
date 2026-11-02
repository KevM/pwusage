# Site history onboarding

Approved design: docs/plans/2026-11-02-history-onboarding-design.md
Implementation plan: docs/plans/2026-11-02-history-onboarding.md

- [x] Bounded fill on `POST /api/mobile/solar-history` (separate history-backfill endpoint removed), Tesla throttle surfaced as 529 + `Retry-After`.
- [x] Detector readiness (`SolarLayoutDetector.readiness`, the producing-day gate on the samples, no fit) and typed `shortfall` + `historyOutlook` feedback.
- [ ] Implement persisted client cursor, retry and checkpoint decisions.
- [ ] Integrate foreground and existing background lifecycle.
- [ ] Add Settings history details and temporary tab accessory.
- [ ] Add reversible Dev setup/restore scripts and device reset.
- [ ] Run required iOS/server verification and commit verified changes.

Current state: server fill contract is implemented and tested (see "Implemented fill contract" in the design). Client integration has not started; next is the on-device job (Task 3).
