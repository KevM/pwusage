# Battery Hold Monitoring Implementation Plan

**Goal:** Finish the approved native hold wording and expose honest server monitoring progress.

**Architecture:** Persist the last cron evaluation on the existing BatteryHold row. Use a pure monitoring summary alongside the existing restore decision, without changing detection behavior or adding Tesla requests. Return optional monitoring data through the authorized hold API; older servers remain compatible.

**Tech Stack:** TypeScript, PostgreSQL, SwiftUI, Swift Testing, Vitest.

## Tasks
1. Test monitoring states, stale readings, quarter-hour countdown, and persistence/error reporting. Add a generated migration for optional JSONB monitoring on BatteryHold, a typed summary, and cron recording. Preserve automatic/manual reserve safeguards.
2. Add optional native monitoring decoding and presentation tests. Display last check, sample age, estimated excess power (not appliance identification), next scheduled check, and honest overdue/error states. Timer holds retain clock behavior.
3. Use visible Battery Hold / Hold Active toolbar labels with the same battery icon. Change stop button and confirmation to Stop the Battery Hold. Remove permanent refresh button; refresh stale charge on sheet entry when no hold is active and offer Try Again for recovery. Retain pull-to-refresh.
4. Run focused and full native tests through run-tests.sh, web tests, lint and builds; inspect normal/accessibility previews. Review and commit verified changes. Database migration and server deployment must precede device verification of monitoring.
