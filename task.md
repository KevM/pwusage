# iOS Solcast load timing

- [x] Restart from `origin/main` with configurable load profiles/tariff timeline from PR #115.
- [x] Reapply the Solcast design and implementation plan commits.
- [x] Baseline verification and prerequisite review.
- [x] Task 1: Typed provider contract and interval aggregation. (`37c5e54`)
- [x] Task 2: Local credentials, selection, cache, and request budget. (`b757511`)
- [x] Task 3: Bounded historical planning context. (`39daa1b`)
- [x] Task 4: Pure lowest-cost comparison engine. (`0008ef1`)
- [ ] Task 5: Connection settings and foreground orchestration. (Luna implementing)
- [ ] Task 6: Recommendation presentation and fallback.
- [ ] Task 7: Integration verification and handoff.

## Notes

- Sol coordinates; Luna implements one bounded task at a time.
- Native tests run only through `cmd/ios-app/run-tests.sh`, sequentially.
- No live Solcast quota use in automated verification.
- Solcast keys/resource IDs/forecasts remain device-local.
