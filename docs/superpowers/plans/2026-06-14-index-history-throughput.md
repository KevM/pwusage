# Index-History Backfill Throughput Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `index-history` backfill complete dramatically faster by fetching each tick's days from Tesla concurrently (#1) and raising the pg_cron trigger cadence from every 5 min to every 1 min (#2).

**Architecture:** The slow part of a backfill tick is a sequential chain of Tesla round-trips — two per day (`getEnergyHistory` + `getSoeHistory`), each ~1s — which exhausts the 50s budget at ~25 days/tick. The rollup itself must stay sequential (each day's tank seed depends on the prior day's end state), so we parallelize **only the fetch**: process days in batches of size `concurrency`, fetch the whole batch concurrently, then roll the batch up in ascending date order. Default `concurrency = 1` makes the new code behaviorally identical to today's, so all existing tests pass unchanged; the route opts into real parallelism via an env var. Separately, a new idempotent migration re-schedules the pg_cron job to every minute.

**Tech Stack:** TypeScript, Next.js route handlers, Vitest, Postgres (Supabase) with `pg_cron` + `pg_net`, Vercel Hobby (60s function cap).

---

## Background (read before starting)

- Worker tick entry point: [src/app/api/cron/index-history/route.ts](../../../cmd/next-app/src/app/api/cron/index-history/route.ts) — claims one site via `RollupBackfillRepo.claimNext()` and calls `BackfillService.processSite(...)` with `{ daysPerTick, budgetMs }`.
- Tick loop under change: [src/lib/battery-provenance/backfill-service.ts](../../../cmd/next-app/src/lib/battery-provenance/backfill-service.ts) — currently a per-day `while` loop: fetch one day → `rollupDay` → `recordProgress`.
- Existing tests (must keep passing): [src/lib/battery-provenance/backfill-service.test.ts](../../../cmd/next-app/src/lib/battery-provenance/backfill-service.test.ts).
- Fetch path (two Tesla calls per day): `fetchRange` in [src/lib/importer/index.ts](../../../cmd/next-app/src/lib/importer/index.ts) (~line 229).
- Current cadence migration to supersede: [cmd/next-app/db-migrations/20260614120022_index_history_cron_5min.sql](../../../cmd/next-app/db-migrations/20260614120022_index_history_cron_5min.sql).
- **Why the rollup cannot be parallelized:** `RollupService.rollupDay` seeds each day's `Tank` from `getSeedTank(siteId, dayStart)` (the prior day's persisted end state) and flips a stateful `genesis_anchored` flag. Days must therefore be *rolled up* strictly in order; only the *fetch* is independent.

All commands run from `cmd/next-app`.

---

## File Structure

- **Modify** `cmd/next-app/src/lib/battery-provenance/backfill-service.ts` — add `concurrency` to `TickOptions`; rewrite `processSite` to batch-fetch then sequential-rollup.
- **Modify** `cmd/next-app/src/lib/battery-provenance/backfill-service.test.ts` — add concurrency-behavior tests; existing tests stay as-is.
- **Modify** `cmd/next-app/src/app/api/cron/index-history/route.ts` — add `INDEX_HISTORY_FETCH_CONCURRENCY` env, pass `concurrency` into `processSite`.
- **Create** `cmd/next-app/db-migrations/<timestamp>_index_history_cron_1min.sql` — re-schedule pg_cron to every minute (idempotent).

---

## Task 1: Batch-concurrent fetch in BackfillService

**Files:**
- Modify: `cmd/next-app/src/lib/battery-provenance/backfill-service.ts`
- Test: `cmd/next-app/src/lib/battery-provenance/backfill-service.test.ts`

- [ ] **Step 1: Add the failing concurrency tests**

Append these tests inside the existing `describe('BackfillService.processSite', ...)` block in `backfill-service.test.ts` (keep all existing tests unchanged):

```ts
  it('fetches a batch of pre-retention days in parallel (up to concurrency)', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchRange = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve(); // yield so sibling fetches can start before this one resolves
      active -= 1;
      return [] as EnergyData[];
    });
    const deps = makeDeps({ fetchRange });
    await new BackfillService(deps).processSite(
      job({ newestDate: '2021-06-03' }), // 3 days -> one batch
      { daysPerTick: 100, budgetMs: 1e9, concurrency: 3 },
    );
    expect(fetchRange).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(3);
  });

  it('rolls up batched days in ascending date order despite concurrent fetch', async () => {
    const deps = makeDeps();
    await new BackfillService(deps).processSite(
      job({ newestDate: '2021-06-03' }),
      { daysPerTick: 100, budgetMs: 1e9, concurrency: 3 },
    );
    const dates = (deps.rollupDay as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(dates).toEqual(['2021-06-01', '2021-06-02', '2021-06-03']);
  });

  it('caps a batch at daysPerTick even when concurrency is larger', async () => {
    const deps = makeDeps();
    await new BackfillService(deps).processSite(
      job(), // 5 days available
      { daysPerTick: 2, budgetMs: 1e9, concurrency: 5 },
    );
    expect((deps.fetchRange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect((deps.rollupDay as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(deps.recordProgress).toHaveBeenLastCalledWith('S1', '2021-06-03', 2, false);
    expect(deps.markComplete).not.toHaveBeenCalled();
  });

  it('does not start a new batch once the budget is exhausted', async () => {
    let t = 0;
    const deps = makeDeps({ now: () => (t += 100) }); // startedAt=100, first while-check=200
    await new BackfillService(deps).processSite(
      job(), // 5 days available
      { daysPerTick: 100, budgetMs: 150, concurrency: 2 },
    );
    // Batch 1 (2 days) runs; the budget check before batch 2 fails -> stop mid-job.
    expect((deps.rollupDay as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(deps.markComplete).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/lib/battery-provenance/backfill-service.test.ts`
Expected: the four new tests FAIL. The most likely failure is `concurrency` being ignored (`maxActive` is `1`, not `3`) and/or a TS error that `concurrency` is not a property of `TickOptions`. Existing tests still PASS.

- [ ] **Step 3: Implement batch-concurrent fetch**

In `backfill-service.ts`, extend `TickOptions`:

```ts
export interface TickOptions { daysPerTick: number; budgetMs: number; concurrency?: number; }
```

Replace the entire `processSite` method body with:

```ts
  async processSite(job: BackfillJob, opts: TickOptions): Promise<void> {
    const d = this.deps;
    let cursor = job.cursorDate;
    let daysDone = job.daysDone;
    let anchored = job.genesisAnchored;
    const startedAt = d.now();
    const concurrency = Math.max(1, opts.concurrency ?? 1);

    try {
      const site = await d.loadSite(job.siteId);
      let processed = 0;

      while (
        cursor <= job.newestDate &&
        processed < opts.daysPerTick &&
        d.now() - startedAt < opts.budgetMs
      ) {
        // Build the next batch of days (ascending), bounded by concurrency,
        // the remaining day-per-tick cap, and newest_date.
        const batch: Array<{ date: string; start: Date; end: Date; isOld: boolean }> = [];
        let scan = cursor;
        while (
          batch.length < concurrency &&
          processed + batch.length < opts.daysPerTick &&
          scan <= job.newestDate
        ) {
          const { start, end } = d.localDayBounds(scan, site.timezone);
          batch.push({ date: scan, start, end, isOld: end.getTime() < d.retentionCutoff().getTime() });
          scan = addLocalDays(scan, 1);
        }

        // Fetch every day in the batch concurrently. Pre-retention days return rows
        // held in memory (never persisted); within-retention days are persisted via
        // ensureData and rolled up from the DB below.
        const fetched = await Promise.all(
          batch.map(async (day) => {
            if (day.isOld) return await d.fetchRange(site, day.start, day.end);
            await d.ensureData(site.id, day.start, day.end);
            return undefined;
          }),
        );

        // Roll up the batch sequentially to preserve tank-state continuity.
        for (let i = 0; i < batch.length; i++) {
          const day = batch[i];
          const forceGenesisAtStart = !anchored;
          const res = day.isOld
            ? await d.rollupDay(site.id, day.date, { rows: fetched[i], forceGenesisAtStart })
            : await d.rollupDay(site.id, day.date, { forceGenesisAtStart });
          if (!anchored && res.genesisAnchored) anchored = true;

          cursor = addLocalDays(day.date, 1);
          daysDone += 1;
          processed += 1;
          await d.recordProgress(site.id, cursor, daysDone, anchored);
        }
      }
      if (cursor > job.newestDate) await d.markComplete(site.id);
    } catch (e) {
      await d.markError(job.siteId, e instanceof Error ? e.message : String(e));
    }
  }
```

Notes for the implementer:
- `addLocalDays` is already imported at the top of the file — do not re-import.
- Budget is now checked once per *batch* (in the outer `while`), so a tick may overshoot by at most one batch of rollups. That is intentional and safe: rollups are local DB/CPU work (fast); the slow Tesla fetches are already parallelized, and there is a 10s buffer below the 60s function cap (`BUDGET_MS = 50_000`).
- With `concurrency = 1` the batch is always one day, reproducing today's exact behavior — that is why the existing tests pass without modification.

- [ ] **Step 4: Run the full backfill-service suite**

Run: `npm test -- src/lib/battery-provenance/backfill-service.test.ts`
Expected: ALL tests PASS (the original suite plus the four new tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/battery-provenance/backfill-service.ts cmd/next-app/src/lib/battery-provenance/backfill-service.test.ts
git commit -m "feat(roi): batch-concurrent Tesla fetch in backfill tick

Parallelize the per-day Tesla round-trips within an index-history tick
while keeping rollups strictly sequential (tank-state continuity).
Default concurrency=1 preserves existing behavior."
```

---

## Task 2: Wire fetch concurrency into the index-history route

**Files:**
- Modify: `cmd/next-app/src/app/api/cron/index-history/route.ts`

This route has no unit test today (it composes many repos and a live Tesla client). It is a thin wiring change verified by lint + build, consistent with the existing route's lack of tests.

- [ ] **Step 1: Add the concurrency env constant**

In `route.ts`, immediately after the existing `SITES_PER_TICK` constant, add:

```ts
const FETCH_CONCURRENCY = parseInt(process.env.INDEX_HISTORY_FETCH_CONCURRENCY || '6', 10);
```

- [ ] **Step 2: Pass concurrency into processSite**

Change the `processSite` options object from:

```ts
      { daysPerTick: DAYS_PER_TICK, budgetMs: BUDGET_MS },
```

to:

```ts
      { daysPerTick: DAYS_PER_TICK, budgetMs: BUDGET_MS, concurrency: FETCH_CONCURRENCY },
```

- [ ] **Step 3: Lint and build**

Run: `npm run lint && npm run build`
Expected: both PASS with no errors.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/src/app/api/cron/index-history/route.ts
git commit -m "feat(roi): opt index-history into concurrent fetch via INDEX_HISTORY_FETCH_CONCURRENCY (default 6)"
```

---

## Task 3: Re-schedule the pg_cron trigger to every minute

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_index_history_cron_1min.sql`

- [ ] **Step 1: Generate the migration file**

Run: `npm run db:migration:create index_history_cron_1min`
Expected: prints the path of a new timestamp-prefixed file under `db-migrations/`. Note that exact path.

- [ ] **Step 2: Replace the generated file's contents**

Overwrite the entire generated file with this SQL (idempotent; reuses the vault secrets created by the original `20260613222439_index_history_cron_trigger.sql`):

```sql
-- Migration: index_history_cron_1min
--
-- Re-schedule the index-history trigger from every 5 min to every 1 min. Paired
-- with batch-concurrent Tesla fetches in the worker (INDEX_HISTORY_FETCH_CONCURRENCY),
-- this drives the one-time historical backfill to completion much faster. Each tick
-- is bounded to <=60s (Vercel Hobby cap) and claims jobs FOR UPDATE SKIP LOCKED, so a
-- 1-min cadence cannot overlap or double-process a site. Reuses existing vault secrets
-- (index_history_cron_target_url, cron_secret). Idempotent: unschedule-if-present,
-- then (re)schedule.

SELECT cron.unschedule('index-history-trigger') FROM cron.job WHERE jobname = 'index-history-trigger';

SELECT cron.schedule(
  'index-history-trigger',
  '* * * * *',
  $$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'index_history_cron_target_url' LIMIT 1),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 5000
  );
  $$
);
```

- [ ] **Step 3: Sanity-check the SQL**

Read the file back and confirm: schedule string is `'* * * * *'`, the `cron.unschedule` guard is present, and the vault secret names exactly match those in `20260613222439_index_history_cron_trigger.sql` (`index_history_cron_target_url`, `cron_secret`). No local DB run is required — this migration only touches the prod scheduler and runs on merge to main.

- [ ] **Step 4: Commit**

```bash
git add cmd/next-app/db-migrations/
git commit -m "feat(roi): re-schedule index-history pg_cron trigger to every minute"
```

---

## Rollout & Verification

The cron migration only takes effect in prod on merge to main (CI backs up the DB, then runs migrations). The worker change (Tasks 1–2) ships with the deploy. Recommended sequence and what to watch:

1. **Confirm throughput rises.** Watch the `RollupBackfill` row's `days_done` advance per tick. Pre-change baseline was ~25 days/tick at 5-min cadence (~300 days/hr). After parallel fetch, each tick should approach the `DAYS_PER_TICK` cap (45) instead of the 50s budget; at 1-min cadence that is up to ~2,700 days/hr per site.
2. **`DAYS_PER_TICK` may become the new ceiling.** Once fetches are concurrent, ticks will likely hit the 45-day cap well within the 50s budget. This is tunable with **no code change** via the `INDEX_HISTORY_DAYS_PER_TICK` env var — raise it (e.g. 90) if ticks finish fast and stay under 60s.
3. **Watch for Tesla rate limiting (429s).** 1-min cadence × concurrency 6 is a large increase in request rate. Tune down via `INDEX_HISTORY_FETCH_CONCURRENCY` (env, no deploy) if 429s appear in logs; `markError` will retry-with-backoff per the repo's existing logic.
4. **Watch pg_net delivery.** `pg_net` is fire-and-forget. Check `SELECT status_code, count(*) FROM net._http_response GROUP BY 1 ORDER BY 1;` for non-200s after rollout.
5. **One-line revert for cadence** if rate limits bite: re-apply the every-5-min schedule (re-run the body of `20260614120022_index_history_cron_5min.sql`, or a new migration with `'*/5 * * * *'`). Concurrency can be neutralized independently by setting `INDEX_HISTORY_FETCH_CONCURRENCY=1`.

## Risks & Notes

- **Concurrent token refresh.** Several `fetchRange` calls now run at once against the same site's Tesla client; a token expiry mid-batch could trigger multiple simultaneous 401-refresh attempts. This is a pre-existing client concern surfaced by concurrency — watch for duplicate-refresh log noise on first rollout. Not addressed in this plan (out of scope for #1/#2); flag a follow-up if it misbehaves.
- **Budget overshoot is bounded.** A tick can exceed `BUDGET_MS` by at most one batch of *rollups* (local work), which stays comfortably under the 10s buffer to the 60s hard cap.
- **Scope.** This plan covers #1 (concurrent fetch) and #2 (1-min cadence) only. Dropping the redundant `getSoeHistory` round-trip (#3) and moving to Vercel Pro for a 300s `maxDuration` (#4) are deliberately excluded.
