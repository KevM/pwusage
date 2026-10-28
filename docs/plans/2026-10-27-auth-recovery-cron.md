# Cron recovery after Tesla access returns

**Goal:** Let the existing gap-heal cron repair recently recovered sites without requiring a live-data visit, and expose each bounded repair attempt to monitoring.

**Approach:** Keep the existing two-hour pg_cron schedule, per-site import lock, three-day-window cap, 35-second work budget and 50-second I/O deadline. Select a site if its owner can call Tesla and either it was used within seven days or its last outage ended within the 14-day recovery window. Preserve the existing outage-day range expansion and planner rules for settled days. Do not change account verification, battery commands or notification delivery.

**Implementation:**

1. Add failing selection tests, including real PostgreSQL cases for an idle restored site, stale restore, ongoing outage, unavailable credentials, and ordinary active sites.
2. Pass a separate recovery cutoff into `SiteRepo.getSitesForGapHeal`; apply the auth requirements outside the activity/recovery OR expression. Keep least-recently-imported ordering.
3. Add failing tests for per-site repair checkpoints, auth timestamps, processed/planned window counts, covered recovered sites and interruption evidence.
4. Emit start/result checkpoints during the service loop, rather than after the full batch. Export only allowlisted fields; keep raw exception messages out of structured telemetry. Label a complete result as no further *planned* work, not guaranteed full history.
5. Document monitoring fields and limitations. Run targeted tests, local PostgreSQL tests, full unit tests, lint and production build, review the diff, then commit.

No production DB changes or Tesla fetches are needed for implementation or verification. Recovery remains bounded to the last recorded outage and the existing 14-day retry window; this does not implement indefinite history onboarding or an outage ledger.

**Validation (2026-10-27):** Regression reproduced before the fix in local PostgreSQL (only the live site was selected; both idle recovered sites were absent). After the fix: 1,594 unit tests passed; 86 focused tests including the PostgreSQL selection and auth-trigger fixtures passed; lint and the standard Turbopack production build passed. Integration suites outside the focused run remain skipped in the normal unit run. The build used a dummy local DB URL; no production connection or Tesla fetch was needed.
