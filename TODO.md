# TODO

Cross-session work that didn't fit the current focus. Pull from this list when picking up new work.

## How to use this list

When starting fresh work in this repo, check this file. If a session begins something here, leave a short note (date + branch/PR) under the item so the next session knows it's in flight. Once landed, delete the item.

## DB egress: remaining reduction candidates

The July 2026 Supabase egress spike was traced to site queries duplicating wide
columns (Site.json, Tesla tokens, live_status_cache) across the tariff join
fan-out on the TRMNL markup hot path; that and the markup route's duplicate
usage-by-TOU fetch were fixed (2026-07-18, branch `claude/db-egress-spike-eie52j`).
Candidates that remain, in rough value order:

- **`getExistingTimestamps` returns every 5-min timestamp** in the audited
  range (~8.5k rows per billing cycle) on each `/api/sync` step, and
  `DataSyncer` retries up to 15× per stage, 2 stages, re-running hourly.
  Aggregating per-day stats (count, first, last, max interior gap via `lag()`)
  in SQL would cut it ~300×, but must reproduce `auditDays`' site-timezone day
  windows (DST days are pinned by `import-planner.test.ts`) — do it carefully.
- **Live-status cache churn:** `claimLiveRefresh`/`updateLiveStatusCache`
  invalidate the in-memory site cache roughly every 14–16 min per site, so the
  15-min site cache rarely survives. Consider a narrow update that doesn't
  nuke the whole cached site, or a short-TTL request-scoped reread.
- **All tariff versions fetched per markup poll** (`getTariffsForSite` /
  `getSchedulesForSite`, intentionally unfiltered for historical name
  resolution). Version count grows monotonically (append-only); if it gets
  large, resolve names via a slimmer projection or cache the version list.

## TRMNL: Loose Pending Installation Flow Note

- **Note (2026-07-01):** The loose-pending fallback flow (installation row with NULL `uuid` and NULL `plugin_setting_id`, claimed by the next webhook within 15 minutes) has been retained. Database inspection confirmed that loose installations still occur (most recent on June 23, 2026). This fallback remains necessary to handle cases where `plugin_setting_id` is missing from the callback URL during manual setups or when the TRMNL API `fetchMe` fails. Revisit and remove this flow if loose installs stop appearing after the manual-install path is fixed.


## Remove vestigial Go code (low priority)

The Go tree (`cmd/pwrtool`, `internal/`, `go.mod`/`go.sum`) and the legacy Svelte app (`cmd/web-app`) predate the Next.js app and are kept only as reference for how things used to work. Delete them when convenient — nothing depends on them.

## Remove Temporal polyfill after Node.js 26 LTS

`src/lib/billing-cycle.ts` now uses `@js-temporal/polyfill` for timezone-aware date arithmetic. Once Node.js 26 reaches LTS (~mid-2026), remove the polyfill dependency and use native `Temporal` from the runtime instead.

**Change:** Replace `import { Temporal } from '@js-temporal/polyfill'` with `import { Temporal } from 'temporal'` (or native global if available) and remove `@js-temporal/polyfill` from `package.json`.

## Upgrade ESLint to v10 (blocked upstream)

`eslint` is pinned at `^9` because `eslint-config-next` bundles `eslint-plugin-react@7.37.5` (latest), whose eslint peer range caps at `^9.7`. ESLint 10 removed `context.getFilename()`, which that plugin still calls, so `npm run lint` crashes under v10. This is not a config-format issue — the repo already uses flat config (`eslint.config.mjs`).

**Change:** Once `eslint-plugin-react` (and `eslint-config-next`) declare eslint 10 support, bump `eslint` to `^10` and re-run `npm run lint`.

