# History backfill and compact-archive migration

## Intent

Move energy history off 5-minute raw `EnergyData` rows and onto the compact
daily archive (`EnergyDayArchive` + `EnergyDaySummary`). The end state is a
short raw window (about a week) with everything older served from the archive.
The archive is believed to be a drop-in replacement for raw reads; this
migration should confirm that before anything is deleted.

Doing it site by site also fills each site's history back to its install date,
which Smart Shift's household pattern needs (TODO.md, "Backfill and per-slot
rollups").

## Phases

**Phase 1 (this work): backfill and archive, keep raw.** A local script, run
one explicit site at a time:

1. Backfill raw `EnergyData` from Tesla for every missing day from
   `Site.installed` to now.
2. Finalize every finished day older than the 2-day floor into
   `EnergyDayArchive`. Re-running the script later archives the days that have
   finished since. Once retention is lowered, the daily cleanup cron
   (`runHistoryArchive`) handles the one day per day that crosses the cutoff.
3. Delete nothing. Raw rows stay as the recovery source.

**Phase 2 (later, separate PRs, out of scope here):**

- Enable `COMPACT_HISTORY_READS_ENABLED` in production.
- Switch the archive cron to trim mode for migrated sites
  (`control-history-archive.ts trim …`).
- Make gap-heal archive-aware: count archived days as covered, and when it heals
  a day older than the retention cutoff, finalize that day into the archive
  rather than leaving raw rows. Without this, gap-heal (`GAP_HEAL_DAYS = 14`,
  raw-only `countAlignedSamples`) would see trimmed days as holes, re-fetch from
  Tesla, rewrite raw rows, and the invalidation trigger would drop the archive,
  a churn loop.
- Lower `DATA_RETENTION_DAYS` in steps (365 → 30 → 7). The archive cutoff has a
  2-day floor (`GREATEST(retention, 2)` in `archiveCutoff` and
  `HistoryArchiveRepo.next`); going below that would need a change there.
- Raw-only reads to confirm stay correct with a short raw window:
  `today-refresh.ts` (latest raw row), `battery-hold-monitor-service.ts` (last
  30 min raw), `user-repo.ts` admin `last_data_import` (MAX raw timestamp).

**Follow-up (separate design): automatic backfill for new sites.** Smart Shift
benefits from a few years of history, so new sites should backfill on their own
rather than wait for an operator run. Likely shape: a budgeted pg_cron-driven
route (60 s Hobby cap) that calls the same `migrateSiteHistory` module with a
per-run window cap, tracking progress per site (for example a
`history_backfilled_through` column) and stopping at the 2-day floor. Phase 1's
module therefore must stay free of CLI and process concerns so a route can
reuse it.

## Goals

- Every migrated site has raw history from its install date (or as far back as
  Tesla returns) and an archive row for every finished day before the 2-day floor
  that has samples.
- The script is resumable: re-running picks up where it stopped and does no
  work for days already done.
- A per-site report lists days archived, days Tesla had no data for, days that
  are incomplete (sample count short, gaps) and days with incomplete tariff
  attribution.
- It is safe to run against production while the app and crons run.

## Non-goals

- Trimming raw rows, enabling compact reads, changing retention, or changing
  gap-heal (all Phase 2).
- Running every site automatically. The operator picks sites.
- Per-slot rollups for Smart Shift. Backfill unblocks them; building them is
  separate.

## Anti-goals

- Deleting or rewriting existing good raw rows.
- Racing the app's own importer, the archive cron or gap-heal for a site.
- Printing tokens, tariffs or sample arrays in operator output (matches
  `maintain-compact-history.ts`).
- Silently reporting success when Tesla returned partial or no data.

## Constraints and existing pieces to reuse

- **Backfill:** `Importer.ensureDataForRange(siteId, start, end, …, {maxTimeMs,
  maxWindows})` already plans missing day windows clamped to `Site.installed`
  (`planMissingWindows` → `planImport`). It takes the site import lock
  (`withImportLock`, 90 s) and caps windows newest-first. The script calls it in
  a loop until it reports `complete` or makes no progress. Get the Tesla client
  with `createTeslaClientForSite` (handles token refresh and the claim pattern
  in DesignDecisions.md).
- **Archive:** `CompactHistoryStore.finalizeDay(siteId, start, now)` with the
  existing site advisory lock, plus `runCompactMaintenance` (preview/apply,
  `maxDays ≤ 7`, `maxTimeMs ≤ 45 s` per call). The script loops over it in
  date chunks; it does not add a new finalization path.
- **Cutoff:** use `archiveCutoff(now, timezone, 2)` (site midnight minus 2
  days, the archive's floor), independent of `DATA_RETENTION_DAYS`.
- **Tesla:** Energy API calls are not billed (user, 2026-10-16), but one call
  pair (history + SOE) per site-local day means hundreds of calls per site.
  Pace requests and stop cleanly on 401/429.
- **DB:** production is the Supabase Nano tier via the pooler. Keep the script
  to one pool connection's worth of concurrency and measure egress on the Dev
  DB first (feedback: cron egress budget).
- **Runs locally** (`npx tsx scripts/…`), not on Vercel, so the 60 s function cap
  does not apply. Only per-call budgets of the reused functions apply.

## Rollout

1. Dev DB rehearsal with the Harrison site: preview, apply, re-run (expect no
   work), and spot-check that compact reads match raw reads for a few archived
   days (`validate-compact-history-archive.ts`).
2. Production, one explicit site ID per run, oldest-installed first.

## Decided by the user

- Phase 1 keeps raw rows. Trimming and retention cuts come later.
- Long-term target is retention of about a week, eventually as low as a day if
  the archive proves to be a drop-in.
- Gap-heal should produce compact archives for days past the cutoff (Phase 2).
- Phase 1 archives every finished day up to the 2-day floor, not just days past
  the retention cutoff. Raw rows stay, so this is safe; a later raw write to an
  archived day drops that day's archive via the invalidation trigger. This
  avoids a months-long cron backlog when retention is lowered in Phase 2.

## What already exists vs. what is new

- **Archive step: already covered.** `scripts/maintain-compact-history.ts`
  (`runCompactMaintenance`) finalizes a site's date range correctly, but caps
  each run at 7 days / 45 s. The only gap is driving it over a multi-year range.
- **Backfill step: logic exists, no driver.** No script backfills to install
  date: `/api/import` covers 14 days, `validate-import.ts` is a single-day debug
  tool on the first site, `backfill-soc.ts` only fills SOC on existing rows.
  `Importer.ensureDataForRange` already plans missing days back to
  `Site.installed`; nothing calls it over that range.
- **New code is a thin driver only:** one script that loops
  `ensureDataForRange` (backfill) and then `runCompactMaintenance` in ≤7-day
  chunks up to `archiveCutoff` (archive). No new import, finalization or lock
  logic.

## Claude's calls (open to change)

- Site order, Dev-first rehearsal, and one site per invocation.
- Script shape: one driver script, preview by default and `--apply` to write,
  following the `maintain-compact-history.ts` convention.

## Left to the builder

- Exact CLI flags, pacing values and report format.
- Whether the loop lives in a testable lib module (preferred, per the
  refactor-for-cohesion convention) with a thin script wrapper.
