# Design Document: Historic Effective-Dated Rate Plans, Re-attribution Engine & Native Editor

- **Author:** Antigravity / Kevin
- **Date:** 2026-11-11
- **Status:** Draft (Pending User Review)
- **Target Area:** Postgres Schema, Compact History Re-attribution (`cmd/next-app`), Rate Plan APIs, iOS Rate Plan Editor (`cmd/ios-app`), Web Timeline (`cmd/next-app`)
- **Related:** [`DesignDecisions.md`](../../../DesignDecisions.md), [`docs/plans/2026-10-24-day-record-v2.md`](../../plans/2026-10-24-day-record-v2.md), [`docs/plans/2026-10-27-history-onboarding-discussion.md`](../../plans/2026-10-27-history-onboarding-discussion.md), [`docs/voice-and-terms.md`](../../voice-and-terms.md)

---

## 1. Overview and Goals

PWUsage currently attaches only the active `"Tariff"` row (`is_current = true`) synced from Tesla when writing compact energy history (`CompactHistoryStore.writeDay`), and has two precision/history gaps:

1. **Historic rate accuracy:** Utility rates change over time (annual utility rate revisions and CGS-NM sell-back updates). Re-syncing Tesla's current rate plan does not establish when old rates took effect or ended, and writing historical days against today's `is_current` tariff misattributes historical imports, exports, and bills.
2. **Rounding & editability:** Tesla's Fleet API tariff sync rounds rates to the nearest cent (`$0.30` instead of `$0.30084 + FCA/ECC = $0.30335`; `$0.04` instead of `$0.04906`). Users have no UI in PWUsage to enter exact utility rates up to 5 decimal places or manage effective-dated rate plans.

### Goals

- Support **non-overlapping effective-dated rate plans** per site (`[effective_from, effective_to]`, inclusive site-local dates, with `effective_to = NULL` meaning ongoing).
- **Preserve append-only tariff immutability** required by [`DesignDecisions.md`](../../../DesignDecisions.md) (§2) so `EnergyDaySummary.tariff_id` / `tariff_schedule_id` foreign keys remain intact and never cascade-delete or rewrite existing `"Tariff"` rows in place.
- Ensure **user-managed date spans win** over Tesla's cent-rounded automatic sync, while keeping `"Tariff"` rows cleanly modeled for a future opt-in "Push to Tesla" feature.
- Introduce **bounded, newest-first server-side history re-attribution** over `EnergyDayArchive` / `EnergyDaySummary` without re-fetching Tesla telemetry, preserving raw 5-minute energy samples.
- Provide a **native iOS Tesla-style rate plan editor** (supporting up to 5 decimal places on buy/sell prices) and upgrade the **Web rate plan view** to display the effective-dated timeline read-only using the same backend APIs.

### Non-Goals (Deferred to Follow-On Sessions)

- **Utility PDF rate-sheet upload & on-device Apple Intelligence extraction** to pre-populate the iOS editor (will build on top of the APIs and editor defined here).
- **Fixed daily customer charges & separate per-kWh rider line items** (data model remains energy-only `buy_rate` / `sell_rate` per kWh; users may combine energy + riders into the entered rate).
- **Interactive Web editor** (Web displays the read-only effective-dated timeline in this phase; interactive web editing can adopt `/api/site/[id]/tariffs` later).
- **Automatic write-back ("Push to Tesla")** of manual rate plans to the Tesla Fleet API.

---

## 2. Data Model & Effective-Date Timeline

This design adopts **Approach A**: preserve the existing append-only `"Tariff"` -> `"TariffSeason"` -> `"TariffSchedule"` hierarchy and add two tables (`"TariffEffectivePeriod"`, `"SiteTariffReattribution"`) plus a `source` discriminator on `"Tariff"`.

```
"Site" ──< "Tariff" (immutable versions, source IN ('tesla', 'manual'))
   │          ├──< "TariffSeason" ──< "TariffSchedule"
   │          └──< "EnergyDaySummary" (tariff_id, tariff_schedule_id)
   ├──< "TariffEffectivePeriod" (non-overlapping [effective_from, effective_to], references Tariff)
   └─── "SiteTariffReattribution" (bounded async job progress per site)
```

### 2.1 `"Tariff"` Changes

Add `source` and `created_by_user_id` columns to `"Tariff"`:

```sql
ALTER TABLE "Tariff"
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tesla'
  CHECK (source IN ('tesla', 'manual')),
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT
  REFERENCES "User"(id) ON DELETE SET NULL;
```

- Existing rows default to `source = 'tesla'` and `created_by_user_id = NULL`.
- All new `source = 'manual'` rows record `created_by_user_id = actingUserId` (while `source = 'tesla'` system syncs leave `created_by_user_id = NULL`). Using `ON DELETE SET NULL` matches [`20261109135834_add_site_member.sql`](../../../cmd/next-app/db-migrations/20261109135834_add_site_member.sql) and [`20261110084828_user_account_deletion_cascades.sql`](../../../cmd/next-app/db-migrations/20261110084828_user_account_deletion_cascades.sql) so shared sites keep their rate history if a member deletes their account.
- **Unique `is_current` per site:** `20260524_120000_tariff_versioning.sql` originally created `tariff_current_uidx ON "Tariff"(site_id, name) WHERE is_current`, which allowed different tariff names on one site to both claim `is_current = TRUE`. Our migration deduplicates any multi-current site (keeping the highest `id`) and replaces `tariff_current_uidx` with `CREATE UNIQUE INDEX tariff_current_uidx ON "Tariff"(site_id) WHERE is_current` (while keeping `tariff_site_name_version_uidx (site_id, name, version)`).
- **`is_current` invariant:** `Tariff.is_current = TRUE` always points to the single `"Tariff"` row referenced by the `"TariffEffectivePeriod"` covering *today* in `site.timezone` (or the latest span covering/preceding today if no open-ended span exists). All mutations to `"TariffEffectivePeriod"` **demote first** (`UPDATE "Tariff" SET is_current = FALSE WHERE site_id = $1 AND is_current AND id <> $2`) and then promote `id = $2` inside the same database transaction so the non-deferrable partial unique index never trips mid-statement.
- **No delete/mutate rule:** `"Tariff"`, `"TariffSeason"`, and `"TariffSchedule"` rows remain strictly append-only. Editing a manual rate plan creates a new immutable `"Tariff"` version (`version = MAX(version) + 1` for `(site_id, name)`) attributed to the editing user and updates `"TariffEffectivePeriod"` pointers for the edited date span rather than mutating schedules referenced by historical `"EnergyDaySummary"` rows.

### 2.2 `"TariffEffectivePeriod"` Table

```sql
CREATE TABLE IF NOT EXISTS "TariffEffectivePeriod" (
  id                 SERIAL PRIMARY KEY,
  site_id            TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
  tariff_id          INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
  effective_from     DATE NOT NULL,
  effective_to       DATE,
  source             TEXT NOT NULL CHECK (source IN ('tesla', 'manual')),
  updated_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS tariff_effective_period_site_dates_idx
  ON "TariffEffectivePeriod" (site_id, effective_from, effective_to);

ALTER TABLE "TariffEffectivePeriod" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TariffEffectivePeriod" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "TariffEffectivePeriod" TO service_role;
GRANT ALL ON SEQUENCE "TariffEffectivePeriod_id_seq" TO service_role;
```

- `tariff_id` uses `REFERENCES "Tariff"(id) ON DELETE CASCADE` specifically so deleting a `"Site"` (via `AccountDeletionRepo.deleteAccount` or `SiteRepo.purgeOrphanedSites`) never fails if Postgres fires `"Site" -> "Tariff"` cascade before `"Site" -> "TariffEffectivePeriod"`. Application mutations on periods NEVER delete `"Tariff"` rows (`"Tariff"` remains append-only).
- **`MAX_EFFECTIVE_PERIODS_PER_SITE = 50`:** Span creation/splitting checks that the resulting count of `"TariffEffectivePeriod"` rows for `site_id` does not exceed `50` (`400` otherwise) to prevent unbounded timeline fragmentation.

- `updated_by_user_id` tracks which user created or last modified that effective span (populated for `'manual'` span writes and for user date adjustments on `'tesla'` spans; `NULL` for automatic Tesla syncs or after user account deletion).

- **Date semantics:** `effective_from` and `effective_to` are inclusive **site-local calendar dates** (`YYYY-MM-DD` in `Site.timezone`). `effective_to = NULL` means ongoing (`+infinity`).
- **Non-overlap invariant:** For any `site_id`, no two rows in `"TariffEffectivePeriod"` may share any calendar date. Non-overlap is enforced in application transaction code under a `SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE` lock and optionally reinforced with an exclusion constraint:
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE "TariffEffectivePeriod"
    ADD CONSTRAINT tariff_effective_period_no_overlap
    EXCLUDE USING gist (
      site_id WITH =,
      daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
    );
  ```
- **Gaps allowed:** History before the earliest `effective_from`—or any gap created by explicitly deleting a manual span—is valid. When attributing a day in a gap, resolution falls back cleanly (see §3.1).

### 2.3 Span Mutation Rules (Split / Trim / Replace / Delete)

All span writes run inside a Postgres transaction holding `SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE`:

1. **Insert or resize a manual span `[A, B]` (`B` may be `NULL`):**
   - Existing spans completely outside `[A, B]` remain untouched.
   - An existing span strictly contained inside `[A, B]` is deleted from `"TariffEffectivePeriod"` (the underlying `"Tariff"` row stays untouched).
   - An existing span partially overlapping `[A, B]` on the left is trimmed to end at `A - 1 day`.
   - An existing span partially overlapping `[A, B]` on the right is trimmed to start at `B + 1 day`.
   - An existing span `[X, Y]` that strictly encloses a finite `[A, B]` (`X < A` and `B < Y`) is split into `[X, A - 1 day]` and `[B + 1 day, Y]`, preserving the existing fragment's original `tariff_id`, `source`, and `updated_by_user_id` so untouched dates keep their original author attribution.
   - Trimming an existing overlapping span on the left or right likewise preserves the surviving fragment's `updated_by_user_id`.
   - Insert the new manual span `[A, B]` with `updated_by_user_id = actingUserId`.
   - Coalesce adjacent spans only if desired; keeping split fragments separate is valid and preserves creation timestamps.
2. **Edit schedule/rates or dates of an existing manual period (`PATCH /api/site/[id]/tariffs/[periodId]`):**
   - Look up the existing `"TariffEffectivePeriod"` row (and its old `[oldFrom, oldTo]`).
   - If the tariff definition (`name`, seasons, schedules, rates) changed, insert a new `"Tariff"` row (`source = 'manual'`, `version = nextVersion`, `content_hash`) plus its `"TariffSeason"` and `"TariffSchedule"` rows; otherwise reuse `period.tariff_id`.
   - Delete the existing `periodId` row and re-insert `[newFrom, newTo]` with the target `tariff_id` using rule 1 (splitting/trimming any newly overlapped neighbors). If shrinking a manual period vacates dates adjacent to a `'tesla'` span with no intervening `'manual'` span, extend that `'tesla'` span across the vacated dates (leaving `'manual'` neighbors untouched); otherwise any remaining un-bridged dates appear as an explicit fallback indicator row in the UI rather than disappearing silently. Recompute `Tariff.is_current`.
   - Enqueue bounded re-attribution over the union of `[oldFrom, oldTo]` and `[newFrom, newTo]`.
3. **Delete a manual period (`DELETE /api/site/[id]/tariffs/[periodId]`):**
   - Allowed only when `source = 'manual'` (`400` if `source = 'tesla'`).
   - Deletes only the `"TariffEffectivePeriod"` row (never `"Tariff"`). If an adjacent `'tesla'` span borders the vacated dates (including split `'tesla'` fragments around the deleted manual span that share the same `tariff_id`), heal/coalesce the `'tesla'` span back across those dates; otherwise, if today is uncovered and a `'tesla'` tariff exists, insert an ongoing `'tesla'` span from `today` so live operations stay priced, and surface any historical gap explicitly in the UI. Recomputes `Tariff.is_current`.
   - Enqueues bounded re-attribution over the deleted span's date range so affected days fall back accurately.

### 2.4 `"SiteTariffReattribution"` Table

Tracks per-site re-attribution state so work stays idempotent across retries, concurrent edits, and cron invocations:

```sql
CREATE TABLE IF NOT EXISTS "SiteTariffReattribution" (
  site_id              TEXT PRIMARY KEY REFERENCES "Site"(id) ON DELETE CASCADE,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'running', 'idle', 'failed')),
  generation           INTEGER NOT NULL DEFAULT 1,
  from_date            DATE NOT NULL,
  to_date              DATE,
  cursor_day_start     TIMESTAMPTZ,
  total_days           INTEGER NOT NULL DEFAULT 0,
  processed_days       INTEGER NOT NULL DEFAULT 0,
  updated_days         INTEGER NOT NULL DEFAULT 0,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  requested_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- `from_date` / `to_date` delimit the union of site-local calendar dates impacted since the job started (`to_date = NULL` means through the newest stored `EnergyDayArchive` day).
- **Coalescing & fencing concurrent workers (`generation`):** Every call to `enqueueTariffReattribution` increments `generation = generation + 1`, widens `[from_date, to_date]` when active (`status IN ('pending', 'running')`), resets `cursor_day_start = NULL`, recomputes `total_days`, resets `processed_days = 0`, `updated_days = 0`, `attempt_count = 0`, `last_error = NULL`, and sets `status = 'pending'`. Each chunk transaction in `runSiteReattribution` reads `expectedGeneration` at chunk start and fences its final cursor update (`UPDATE "SiteTariffReattribution" ... WHERE site_id = $1 AND generation = $2`). If 0 rows update (because a newer save superseded the job mid-chunk), the transaction rolls back `EnergyDayArchive`/`EnergyDaySummary` writes cleanly and exits (`outcome: 'superseded'`) without overwriting the reset cursor.

### 2.5 Backfill Migration (`db-migrations/`)

A single SQL migration (plus any helper constraint):

1. Adds `Tariff.source`, creates `"TariffEffectivePeriod"`, creates `"SiteTariffReattribution"`.
2. Backfills one `"TariffEffectivePeriod"` per site that currently has `Tariff.is_current = TRUE`, setting:
   - `tariff_id` = the `is_current = TRUE` row's `id`
   - `source = 'tesla'`
   - `effective_from` = `COALESCE((SELECT (MIN(day_start) AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date FROM "EnergyDayArchive" a WHERE a.site_id = s.id), (now() AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date)`
   - `effective_to = NULL`
3. Does **not** queue site-wide re-attribution during migration so existing sites suffer zero unexpected churn on deploy.

### 2.6 Tesla Sync Coexistence (`TariffRepo.addTariffVersion`)

Currently [`TariffRepo.addTariffVersion`](../../../cmd/next-app/src/lib/tariff-repo.ts#L50-L117) compares `content_hash` against `is_current = TRUE` and flips `is_current = TRUE` unconditionally whenever Tesla returns a tariff change. Under effective-dated tariffs:

1. **Deduplicate against the latest `'tesla'` tariff** (`ORDER BY id DESC WHERE source = 'tesla'`), not blindly against `is_current`. This prevents Tesla's periodic sync from endlessly inserting duplicate cent-rounded `"Tariff"` versions while a manual plan is active.
2. When Tesla's hash actually changes (`content_hash` differs from the latest `'tesla'` tariff), insert a new `"Tariff"` version with `source = 'tesla'`.
3. **Never overwrite `'manual'` spans:** Find the `"TariffEffectivePeriod"` covering `today` (site-local):
   - If `today` is uncovered (gap) or covered by a `'tesla'` span, set/split/insert a `'tesla'` span starting at `today` (`effective_to` stays `NULL` if no later manual span exists, or ends the day before the next future manual span) and set `is_current = TRUE` on the new `'tesla'` tariff.
   - If `today` is covered by a `'manual'` span, keep `Tariff.is_current = TRUE` on the manual tariff, keep all `'manual'` spans untouched, and record the new `'tesla'` version cleanly for UI divergence comparison (`hasTeslaDivergence`). Re-attribution is **not** triggered when manual plans already cover those dates.
4. Expose read-only comparison metadata (`teslaLatestTariff` vs active manual tariff) on `GET /api/site/[id]/tariffs` so the iOS UI can surface a non-destructive notice (e.g., *"Utility plan updated in Tesla · Your custom rate plan stays active"*), without touching manual rates.

---

## 3. Re-attribution Engine & Write-Path Integration

### 3.1 Effective Tariff Resolution for Any Day

Replace [`CompactHistoryStore.tariffs(client, siteId, true)`](../../../cmd/next-app/src/lib/prototypes/compact-history-store.ts#L287) in `writeDay` and in re-attribution with a shared resolver `resolveTariffForSiteDate(client, siteId, siteLocalDate)`:

1. Query `"TariffEffectivePeriod"` for `site_id` where `effective_from <= siteLocalDate` and `(effective_to IS NULL OR effective_to >= siteLocalDate)`.
2. Fallback if `siteLocalDate` precedes all spans or falls in a gap:
   - Prefer the latest `"TariffEffectivePeriod"` ending *before* `siteLocalDate` (most recent known plan before a deleted gap).
   - Otherwise fall back to the earliest `"TariffEffectivePeriod"` on the site (e.g., for history collected before the site's first recorded effective date).
   - Otherwise fall back to `Tariff WHERE site_id = $1 AND is_current = TRUE`.
3. Load `"Tariff"`, `"TariffSeason"`, and `"TariffSchedule"` rows for that resolved `tariff_id` and construct a `Schedule` instance ([`schedule.ts`](../../../cmd/next-app/src/lib/schedule.ts)).

For cross-day DST/UTC boundaries in `writeDay`, `siteLocalDate` is derived from `start` in `Site.timezone` (consistent with how [`CompactHistoryStore`](../../../cmd/next-app/src/lib/prototypes/compact-history-store.ts#L270-L300) already partitions `day_start`).

### 3.2 `timelineRevision` Stability

Update `currentTariffTimelineRevision` in `src/lib/prototypes/day-attribution.ts` from a constant placeholder to reflect the tariff version driving a day's attribution:

```ts
export function tariffTimelineRevision(tariffId: number): string {
  return `effective-tariff:${tariffId}`;
}
```

Storing `attribution.timelineRevision = "effective-tariff:${tariffId}"` lets diagnostic queries and re-attribution inspect immediately which `"Tariff"` row produced each archived day's segments.

### 3.3 Bounded Two-Phase Re-attribution Algorithm

Note that in our engine, a price-only change between two `"Tariff"` versions creates a distinct `"Tariff"` row (`tariff_id`), so `"EnergyDaySummary"` must be rewritten to reference the updated `tariff_id` and `tariff_schedule_id` even when daily segment boundaries remain identical. Conversely, when a re-attribution pass revisits days already pointing to the same `tariff_id` and identical `segments`, those days are skipped completely without decoding telemetry payloads.

Instead of relying on a single static batch size for the entire invocation, execution uses a **time-budgeted outer loop** (matching [`heal-gaps/route.ts`](../../../cmd/next-app/src/app/api/cron/heal-gaps/route.ts) and [`gap-heal.ts`](../../../cmd/next-app/src/lib/gap-heal.ts)) over **small checkpointed chunks** (`REATTRIBUTION_CHUNK_DAYS = 15` default, configurable for tuning):

1. **Metadata scan (newest-first):** Fetch up to `chunkDays` rows from `"EnergyDayArchive"` for `site_id` matching `(day_start < cursor_day_start OR cursor_day_start IS NULL)` and within `[from_date, to_date]` (converted to site-local date boundaries), ordered by `day_start DESC`, selecting **metadata only** (`day_start`, `revision`, `schema_version`, `sample_count`, `attribution`)—excluding heavy `payload` bytes.
2. **Phase 1 fast-skip vs Phase 2 candidate selection:**
   - For each day row, resolve `tariff` and `schedule` for `dayLocalDate`, and compute `nextAttribution = deriveDayAttribution(schedule, tariff.id, dayStart, dayEnd)`.
   - Because each stored segment embeds immutable `(offset, tariffId, scheduleId)` values (existing records store `timelineRevision = "current-tariff:${tariffId}"`, while new/rewritten records store `"effective-tariff:${tariffId}"`), Phase 1 fast-skips whenever `segmentsEqual(row.attribution?.segments, nextAttribution.segments)` and `row.attributionComplete === expectedAttributionComplete`—without forcing redundant payload decodes on historical days whose tariff assignment did not change!
   - Otherwise, add the day to the rewrite list for Phase 2.
3. **Phase 2 rewrite & fenced checkpoint:**
   - Batch-fetch `payload` only for the rewrite list, decompress (`gunzip`/`brotli` via `compact-day-record.ts`), run `buildDayMetadataV3(...)` + `replaceDay(...)` inside a chunk transaction guarded by `claimMutation(client, siteId)` and `transactionTimeoutMs <= 15_000` in [`CompactHistoryStore`](../../../cmd/next-app/src/lib/prototypes/compact-history-store.ts#L76), updating `"SiteTariffReattribution"` fenced by `WHERE site_id = $1 AND generation = $2`. If the fence matches 0 rows (superseded by a newer save), roll back the chunk transaction cleanly.
4. **Advance cursor & loop check:** Increment `processed_days` and `updated_days`, advance `cursor_day_start` to the oldest `day_start` processed in the chunk, and transition `status = 'idle'` when no earlier archived days remain in `[from_date, to_date]`. Before starting the next chunk, check remaining wall-clock budget; if exhausted, exit cleanly (`stopped: 'time-budget'`) so the next cron invocation picks up at `cursor_day_start`.

### 3.4 Scheduling, Time Budgets & Empirical Tuning

1. **Immediate inline + `after()` drain on save/delete:**
   - `POST / PATCH / DELETE /api/site/[id]/tariffs` synchronously commits `"Tariff"` + `"TariffEffectivePeriod"` + `"SiteTariffReattribution"` (`status = 'pending'`) rows, calls `new SiteRepo().invalidateCache(siteId)` on exit, and returns `200/201` immediately.
   - Using Next.js `after(...)`, the route runs a short time-budgeted loop (`AFTER_MAX_TIME_MS = 6_000`, `withIoDeadline(10_000, ...)`), typically completing the current billing cycle + ~15–60 recent days right away while checkpointing anything remaining to Postgres.
2. **DB-gated background cron `/api/cron/reattribute-tariffs`:**
   - Configured with `maxDuration = 60` (matching the Vercel Hobby limit and [`heal-gaps/route.ts`](../../../cmd/next-app/src/app/api/cron/heal-gaps/route.ts)).
   - Wraps the run in `withIoDeadline(50_000, ...)` (`HARD_DEADLINE_MS = 50_000`) and stops starting new chunks or sites once elapsed wall-clock exceeds `REATTRIBUTION_MAX_TIME_MS = 35_000`.
   - Scheduled every minute by `pg_cron` + `pg_net.http_get`, **gated in SQL** with `AND EXISTS (SELECT 1 FROM public."SiteTariffReattribution" WHERE status = 'pending' OR (status = 'running' AND updated_at < now() - interval '2 minutes'))` so idle minutes incur zero HTTP invocations, zero Postgres connection egress, and zero Axiom events.
   - Add a rule to [`sanitize-dev-copy.sql`](../../../cmd/next-app/scripts/sanitize-dev-copy.sql) resetting copied `status IN ('pending', 'running')` rows to `'idle'` so a mid-run prod dump never triggers background re-attribution on dev/beta.
   - On unhandled exception, increments `attempt_count`, records sanitized diagnostic token in `last_error`, marks `status = 'failed'` once `attempt_count >= 5`, and supports manual retry via API.
3. **Observability & dialing in `REATTRIBUTION_CHUNK_DAYS`:**
   - Emit structured `logEvent` chunk and site timing metrics (`chunkDays`, `skippedDays`, `rewrittenDays`, `scanMs`, `rewriteMs`, `remainingMs`, `claimBusy`, `stopped`) via [`observability.ts`](../../../cmd/next-app/src/lib/observability.ts) (see §8 for the full event catalog and Axiom safety rules).
   - Use initial production/dev timing telemetry to dial `REATTRIBUTION_CHUNK_DAYS` (and any sub-transaction split size if needed) so each Phase 2 write transaction completes comfortably within ~`2–5 s` on live Supabase pooler latency without starving `writeDay` or risking the `15_000 ms` `CompactHistoryStore` transaction timeout.

### 3.5 Bill Calculation & Caching Interaction

Inspecting [`src/lib/mobile-bill-revision.ts`](../../../cmd/next-app/src/lib/mobile-bill-revision.ts), `src/lib/bill-pricing.ts`, and `src/lib/tou-aggregation.ts`:

- Every `"TariffEffectivePeriod"` / `"Tariff"` mutation calls `new SiteRepo().invalidateCache(siteId)` so the 15-minute in-memory site cache never serves stale tariffs.
- `EnergyDaySummary` rows store `tariff_id` and `tariff_schedule_id` per period per day, and `bill-pricing.ts` groups billing cycle energy by `(tariffName, touName)` without filtering by `Tariff.is_current` (per `DesignDecisions.md` §Billing). Keeping the **same rate plan name** across revisions preserves cross-revision netting inside cycles spanning an effective-date boundary.
- Because `CompactHistoryStore.replaceDay` generates a fresh `revision` UUID on updated `"EnergyDayArchive"` rows, `readMobileHistoryRevision` invalidates cached mobile bill snapshots when cycle days change. To prevent a `304 Not Modified` from stranding an active `"Updating historical rates..."` banner after pre-cycle days finish updating, `readMobileBillRevision` also hashes the site's non-idle `SiteTariffReattribution` state (`status, processedDays, updatedDays`, or `null` when idle/absent).
- Bill endpoints (`/api/mobile/bill-summary`) attach optional `tariffReattribution: ReattributionStatusDTO | null` when a re-attribution job is active or failed on the site.

---

## 4. API Contracts

All `/api/site/[id]/tariffs*` endpoints enforce authenticated session/bearer access (`getCurrentUser()` + `verifySiteAccess(siteId)`, returning `401`/`403` otherwise) so every non-Tesla mutation records the acting `user.id`, guard cookie-authenticated mutating endpoints (`POST` / `PATCH` / `DELETE` `/api/site/[id]/tariffs*` and `POST /api/site/[id]/refresh-tariffs`) with `isCrossOriginRequest(req)` (`403`, matching other cookie write routes while permitting native iOS `URLSession` requests that omit `Origin`), and validate inputs strictly (`400` on invalid input). Because the iOS app is in beta, iOS and Next.js migrate directly to the v2 timeline contract in one synchronized change without maintaining dual v1/v2 decoders or response shims.

### 4.1 `GET /api/site/[id]/tariffs`

Returns the complete effective-dated rate plan timeline for a site, plus re-attribution progress and Tesla divergence metadata.

```ts
export interface SiteTariffsTimelineResponse {
  version: 2;
  siteId: string;
  timezone: string;
  currency: string;
  periods: TariffPeriodDTO[];
  reattribution: ReattributionStatusDTO | null;
  teslaSync: {
    latestTariffId: number | null;
    latestTariffName: string | null;
    latestUpdatedAt: string | null;
    differsFromActiveManual: boolean;
  };
}

export interface TariffPeriodDTO {
  periodId: number;
  tariffId: number;
  name: string;
  version: number;
  source: "tesla" | "manual";
  effectiveFrom: string; // YYYY-MM-DD (site-local)
  effectiveTo: string | null; // YYYY-MM-DD or null (ongoing)
  isCurrentToday: boolean;
  updatedBy: {
    email: string | null;
    isCurrentUser: boolean;
  } | null;
  seasons: TariffSeasonInput[];
}

export interface TariffSeasonInput {
  name: string; // e.g. "Winter", "Summer"
  fromMonth: number; // 1..12
  toMonth: number;   // 1..12 (wraparound allowed, e.g. 10 -> 5)
  weekdayPeriods: TimePeriodWindowInput[];
  weekendPeriods: TimePeriodWindowInput[];
}

export interface TimePeriodWindowInput {
  touName: "ON_PEAK" | "PARTIAL_PEAK" | "OFF_PEAK" | "SUPER_OFF_PEAK";
  fromHour: number;   // 0..23
  fromMinute: number; // 0 | 30
  toHour: number;     // 0..23 (or 24 with minute 0 for end-of-day)
  toMinute: number;   // 0 | 30
  buyRate: number;    // >= 0, up to 5 decimal places
  sellRate: number;   // >= 0, up to 5 decimal places
}

export interface ReattributionStatusDTO {
  status: "pending" | "running" | "idle" | "failed";
  fromDate: string;
  toDate: string | null;
  totalDays: number;
  processedDays: number;
  updatedDays: number;
  lastError: string | null;
  updatedAt: string;
}
```

**Mapping `TariffSeasonInput` <-> `"TariffSchedule"` rows:**
- `weekdayPeriods` compile to `"TariffSchedule"` rows for weekdays `0..4` (`Mon..Fri`), matching [`toTeslaWeekday`](../../../cmd/next-app/src/lib/schedule.ts#L16-L20).
- `weekendPeriods` compile to `"TariffSchedule"` rows for weekdays `5..6` (`Sat..Sun`). US observed holidays continue to map to weekend schedules via [`isObservedHoliday`](../../../cmd/next-app/src/lib/schedule.ts).
- **Decompiling layered Tesla schedules (`decompileTariffToSeasons`):** Tesla often emits layered overrides (e.g., an all-day `0..6` `OFF_PEAK` rule paired with a `0..4` `08:00–20:00` `ON_PEAK` override). Rather than filtering raw rows blindly, decompilation evaluates each of the 48 half-hour slots for canonical weekday (Monday) and weekend (Saturday) using the exact specificity order of `Schedule.getTariffPeriodByComponents`, then coalesces adjacent matching slots into contiguous non-overlapping `TimePeriodWindowInput[]` windows.
- All half-hour boundaries map identically to Tesla Fleet API schedules (`fromHour`, `fromMinute`, `toHour`, `toMinute`), supporting wrap-around intervals (e.g. `20:00 -> 08:00`) and all-day single-period intervals (`00:00 -> 24:00` or `00:00 -> 00:00` for slot 0) while rejecting non-zero degenerate zero-length intervals (`08:00 -> 08:00`).

### 4.2 `POST /api/site/[id]/tariffs`

Creates a new `manual` rate plan version and assigns it to `[effectiveFrom, effectiveTo]`, trimming/splitting overlapping `"TariffEffectivePeriod"` rows and queueing bounded re-attribution over `[effectiveFrom, effectiveTo ?? today]`.

- **Body:** `{ name, effectiveFrom, effectiveTo, seasons }`
- **Response (`201 Created`):** Updated `SiteTariffsTimelineResponse`.

### 4.3 `PATCH /api/site/[id]/tariffs/[periodId]`

Edits an existing rate plan period.

- If target `periodId` has `source = 'manual'`: updates dates (`effectiveFrom`, `effectiveTo`) and/or creates a new immutable `"Tariff"` version if `name` or `seasons` changed, re-running overlap split/trim over the union of old and new date bounds.
- If target `periodId` has `source = 'tesla'`: only allows editing `effectiveFrom` / `effectiveTo` (to adjust when a Tesla-synced plan was effective); editing rates/seasons from a `'tesla'` period uses `POST /api/site/[id]/tariffs` ("Copy & Customize") to create a `'manual'` period instead so the original `'tesla'` provenance remains intact.
- **Response (`200 OK`):** Updated `SiteTariffsTimelineResponse`.

### 4.4 `DELETE /api/site/[id]/tariffs/[periodId]`

Removes a `manual` `"TariffEffectivePeriod"` row (`400` if `source = 'tesla'`), updates `Tariff.is_current` if needed, restores any fallback `'tesla'` coverage for today if uncovered, and queues re-attribution across the removed period's date range.

- **Response (`200 OK`):** Updated `SiteTariffsTimelineResponse`.

### 4.5 `POST /api/site/[id]/tariffs/reattribute`

Retries a `'failed'` job (or triggers an explicit catch-up re-attribution across a date range), resetting `attempt_count = 0`, setting `status = 'pending'`, and running an `after()` batch immediately.

### 4.6 `refresh-tariffs` & Bill Endpoints (Clean v2 Cutover)

- Because the iOS app is currently in beta, replace `MobileTariffsResponse` v1 across [`tariff-contract.ts`](../../../cmd/next-app/src/lib/tariff-contract.ts), [`MobileTariffs.swift`](../../../cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift), [`DemoFixtures.swift`](../../../cmd/ios-app/PWUsage/Demo/DemoFixtures.swift), [`PWUsageAPI.swift`](../../../cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift), and `GET /api/site/[id]/tariffs` directly rather than keeping a legacy v1 response format alive.
- Keep `POST /api/site/[id]/refresh-tariffs` as the dedicated Tesla sync action (used by [`SettingsView.tsx`](../../../cmd/next-app/src/components/site/SettingsView.tsx), the Web timeline `"Sync from Tesla"` button, and iOS), invoking updated `TariffRepo.addTariffVersion` (respecting `'manual'` precedence) and returning the updated `SiteTariffsTimelineResponse` (plus `updatedFromTesla: boolean`). `GET /api/site/[id]/refresh-tariffs` is retired in favor of `GET /api/site/[id]/tariffs`.
- Existing `MobileBillResponse` (and web bill payloads) gain an optional `tariffReattribution: ReattributionStatusDTO?` field so Bill views can show when re-attribution overlaps the active billing cycle.

---

## 5. Server Validation Rules

All rate plan writes enforce the following server invariants before opening or committing writes:

1. **Season month coverage (`TariffSeasonInput[]`):**
   - `1` to `6` seasons per plan.
   - Each season has a non-empty trimmed `name` (max 64 chars) and `fromMonth`, `toMonth` integers in `1..12`.
   - Expanding each season across its inclusive circular month range (`Oct -> May` expands to `{10,11,12,1,2,3,4,5}`) must cover **all 12 months exactly once** (no missing month, no month in multiple seasons).
2. **24-hour schedule coverage (weekday and weekend per season):**
   - `1` to `48` period entries per schedule (`periods.length <= 48`).
   - Minutes use 30-minute increments (`0` or `30`).
   - Reject degenerate zero-length periods (`startSlot === endSlot`) except for the explicit single-period all-day encoding (`00:00 -> 24:00`, or `00:00 -> 00:00` when `periods.length === 1` and `fromHour === 0`).
   - Expanding each period `[from, to)` on the 48-slot (30-minute) day circle `[00:00, 24:00)` must cover **all 48 slots (1440 minutes) exactly once** (no gaps, no overlapping slots). Wraparound windows such as `20:00 -> 08:00` expand cleanly to `[20:00, 24:00) U [00:00, 08:00)`.
   - `touName` must be one of `ON_PEAK | PARTIAL_PEAK | OFF_PEAK | SUPER_OFF_PEAK`.
3. **Rates & precision:**
   - `buyRate` and `sellRate` are finite numbers `>= 0` and `<= 10.0` (sanity ceiling), rounded/validated to at most 5 decimal places (`Math.round(val * 100000) / 100000`).
4. **Effective dates & span ceiling:**
   - Valid `YYYY-MM-DD` dates; `effectiveTo === null || effectiveTo >= effectiveFrom`.
   - `effectiveFrom >= '2015-01-01'` and `effectiveFrom <= today + 365 days`.
   - After applying overlap splits/trims, total `"TariffEffectivePeriod"` rows for the site must remain `<= 50` (`400` otherwise).

---

## 6. iOS Rate Plan Timeline & Tesla-Style Editor (`cmd/ios-app`)

Built natively in SwiftUI within `cmd/ios-app`, strictly adhering to [`cmd/ios-app/AGENTS.md`](../../../cmd/ios-app/AGENTS.md), [`docs/voice-and-terms.md`](../../voice-and-terms.md) (plain language: *"Rate Plans"*, *"Rate Period"*, *"Buy"* / *"Sell"*, no *"tariff"* or *"TOU"* abbreviations in UI copy), and SwiftLint (`./cmd/ios-app/lint.sh`, <= 50-line view bodies via decomposed subviews).

### 6.1 Navigation Flow

```
TariffSheet (Rate Plans Timeline)
  ├─ [Sync from Tesla] / Re-attribution progress banner / Tesla divergence banner
  ├─ Period Cards (Active today + Historical, sorted newest-first)
  │    ├─ "Edit Plan" (manual) OR "Copy & Customize" (tesla) ─► RatePlanEditorFlow
  │    ├─ "Edit Dates" ─► EffectiveDatesSheet
  │    └─ "Delete Plan" (manual only, with confirmation dialog)
  └─ "+ Add Rate Plan" ─► RatePlanEditorFlow (seeded from current active plan or blank 1-season Off-Peak template)

RatePlanEditorFlow (Wizard / NavigationStack inside sheet)
  1. Summary Screen (Plan Name, Effective Dates row, Expandable Season cards with Edit links, "Save Rate Plan")
  2. Seasons Screen (12-month vertical block slider + Add/Remove Season)
  3. Rate Schedule Screen ("Time of Use" pattern: Weekdays / Weekends toggle, 24h vertical timeline slider, Add/Delete Period, Rename Period type)
  4. Pricing Screen ("Cost of Electricity" pattern: Weekdays/Weekends horizontal preview strips, Buy & Sell numeric cards up to 5 decimal places)
```

Users can either step forward (`Seasons -> Schedule -> Pricing -> Summary`) when creating a brand-new plan, or jump directly from any `"Edit"` link on **Summary** (`Seasons`, `Weekday Schedule`, `Weekend Schedule`, `Pricing`, or `Effective Dates`) and return cleanly to Summary before tapping **Save Rate Plan**.

### 6.2 Detailed Screen Specifications

1. **Rate Plans Timeline (`TariffSheet` upgrade):**
   - **No 1-second timer / safe sheet polling:** Remove the existing 1-second `TimelineView` from `TariffSheet` (nothing on Rate Plans ticks every second; minute-boundary updates stay on `.task`), and pause background re-attribution polling whenever a child editor sheet (`isPresentingEditor == true`) is open so parent refreshes cannot disrupt slider gestures.
   - **Live updates banner:** If `reattribution.status` is `pending` or `running`, shows a calm inline banner (`ProgressView` + `"Updating historical rates · {processedDays} of {totalDays} days"`), polling `/api/site/{id}/tariffs` cleanly every few seconds while visible and stopping on exit/idle or while an editor sheet is presented. If `failed`, shows `"Could not finish updating history"` + **Retry** button.
   - **Tesla divergence notice:** When `teslaSync.differsFromActiveManual == true`, shows a subtle non-alarming card noting Tesla reported different rounded rates while keeping the user's custom rate plan active, with a quick **"Compare / Add from Tesla"** option if the user actually wants to switch forward.
   - **Timeline cards & explicit gap rows:** Sorted newest-first; if any non-contiguous gap remains between consecutive effective periods (or before the earliest period when history exists), render a subtle inline row (e.g., `"Jan 1, 2025 – May 31, 2025 · Uses previous rate plan"`) so fallback behavior stays visible. Each period card shows:
     - Rate plan name + source badge (`"Custom"` vs `"Tesla"`), plus `"Current"` pill if `isCurrentToday`. For shared sites (or whenever `updatedBy` is present), show lightweight attribution metadata (`"Edited by you"` or `"Edited by <email>"`).
     - Effective date range (`"Jan 1, 2026 – Present"` or `"Jan 1, 2025 – Dec 31, 2025"`).
     - Compact season summary rows with horizontal Weekday/Weekend 24h bar strips and exact Buy/Sell prices formatted dynamically from 2 up to **5 decimal places** (e.g., `$0.30335`, `$0.10`, never truncating non-zero trailing thousandths/ten-thousandths/hundred-thousandths).
     - **Context actions:** Manual cards offer **Edit**, **Copy to New Dates**, **Delete**; Tesla cards offer **Customize Rates**, **Adjust Dates**.

2. **Summary Screen:**
   - Inline editable Rate Plan Name (`TextField`), **pre-filled with the source plan's exact name** on `"Copy & Customize"` / `"+ Add Rate Plan"` (without appending years/dates), plus a brief caption underneath: *"Keep the same rate plan name when updating rates for the same utility plan so billing cycles that cross the start date combine your export cushion accurately."*
   - **Effective Dates** row (`Starts` DatePicker + `"Ongoing"` toggle / `Ends` DatePicker). Notice below dates previews impact: e.g., *"Replaces Tesla plan from Jan 1, 2025 to Dec 31, 2025 and updates stored history for those dates."*
   - Expandable disclosure row per season (`Season 1 · October – May`): expands in place to show the exact horizontal Weekday bar, Weekend bar, and Off-Peak / Peak Buy & Sell prices (`$0.XXXXX / kWh`) with blue `Edit` links matching the Tesla app hierarchy.
   - Primary bottom action button: **Save Rate Plan** (disabled with inline explanation if validation fails; shows loading spinner while POST/PATCH completes).

3. **Seasons Screen (12-month vertical block slider):**
   - Vertical stack of 12 calendar months (`January` through `December`) partitioned into contiguous colored/shaded season blocks (`1..4` supported smoothly via slider; `Add Season` / `Remove Season` buttons on the right, up to 6).
   - **Drag handles:** Horizontal pill handles between adjacent season blocks snap cleanly to month boundaries with light haptic feedback (`UIImpactFeedbackGenerator(.light)`).
   - **Wrap-around support:** Mirrors Tesla's exact behavior for winter seasons like `October – May` (Season 1 owns `Oct–Dec` + `Jan–May`, appearing as matching top and bottom blocks sharing `Season 1`'s label while `June – September` sits in the middle as `Season 2`). Users can drag boundaries smoothly without invalidating month coverage, guaranteeing **all 12 months remain assigned with zero gaps**.
   - Also provide accessible +/- stepper buttons per season boundary for VoiceOver and users preferring tap precision over dragging.

4. **Schedule Screen (24h vertical timeline slider + Weekday/Weekend toggle):**
   - Header chips show `Season X` (`Oct – May`) and segmented toggle **`Weekdays (Mon – Fri)` | `Weekends (Sat – Sun)`** (plus a quick `"Same schedule as weekdays"` checkbox on Weekends, matching the Tesla screenshot).
   - Left column lists active periods for the selected day group (`Super Off-Peak`, `Off-Peak`, `Mid-Peak`, `Peak`), each with color indicator strip, formatted time range (`8:00 AM – 8:00 PM` or `8:00 PM – 8:00 AM` wraparound), and overflow/tap menu to **Change Rate Period Type** or **Remove** (when > 1 period remains), plus **`+ Add Time Period`**.
   - Right side renders the vertical **24-hour color track** from `12:00 AM` (top moon icon) through `12:00 PM` (center sun icon) to `12:00 AM` (bottom moon icon), with 24/48 subtle tick marks and draggable pill handles between adjacent transitions.
   - **Dragging & quantization:** Dragging a handle snaps to **30-minute increments**, constrains handles from crossing past the neighbor handle (minimum 30-minute window width), and updates the adjacent periods' start/end labels live at 60fps with subtle selection haptics. Tap/stepper fallback (`-30m` / `+30m`) is available on the active period row for pinpoint adjustments and accessibility.

5. **Pricing Screen (Buy / Sell per kWh up to 5 decimals):**
   - Displays current season pill and miniature Weekday / Weekend horizontal color bars at the top so the user always sees which hours each rate applies to.
   - Displays one section per distinct `touName` present in that season (`Super Off-Peak`, `Off-Peak`, `Mid-Peak`, `Peak`), each with side-by-side **Buy** and **Sell** cards (`$0.30335`, `$0.04906`).
   - Uses `.decimalPad` keyboard and custom decimal formatter/validator supporting **0 to 5 decimal places**, stripping non-numeric input safely, preventing >5 decimal digits or negative values, and displaying clear inline validation errors.
   - Note on shared period types within a season: Buy/Sell prices belong to `(season, touName)`, matching `TariffSchedule` semantics where all `ON_PEAK` windows in Summer share one Buy rate and one Sell rate.

### 6.3 Shared Client Models & ViewModels (`cmd/ios-app`)

- Add `RatePlanEditorState` (`@Observable @MainActor`) holding an editable draft graph (`RatePlanDraft`, `SeasonDraft`, `DayPeriodDraft`) cleanly separated from read-only DTOs, with pure Swift validation helpers testable without UI.
- Replace [`MobileTariffs.swift`](../../../cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift) v1 models directly with the `SiteTariffsTimelineResponse` v2 DTOs (updating `DemoAPI`, `DemoFixtures`, `DashboardCoordinator`, and `PWUsageAPI` methods: `fetchTariffTimeline`, `refreshTariffsFromTesla`, `createTariffPeriod`, `updateTariffPeriod`, `deleteTariffPeriod`, `retryTariffReattribution`).
- Format helper `RateFormatting.formatRate(_ value: Double) -> String` showing between 2 and 5 significant fraction digits (e.g., `0.10 -> "$0.10"`, `0.30335 -> "$0.30335"`, `0.0005 -> "$0.0005"`).

---

## 7. Web Read-Only Timeline (`cmd/next-app`)

Upgrade [`src/components/site/TariffList.tsx`](../../../cmd/next-app/src/components/site/TariffList.tsx) and the site page data loader:

- Read from the same `/api/site/[id]/tariffs` timeline data model (`SiteTariffsTimelineResponse`).
- Update copy to comply cleanly with [`docs/voice-and-terms.md`](../../voice-and-terms.md) (replacing existing `"Time-of-Use (TOU) rates or tariff settings"` prose with *"Rate Plan"* wording, using `·` for metadata separators, and using compact `"Buy $0.30335/kWh · Sell $0.04906/kWh"` / column labels rather than `"tariff"`/`"TOU"`).
- Display all effective-dated rate plans in chronological newest-first order (plus explicit gap indicator rows when a non-contiguous gap exists between plans) with `"Active today"` / date badges (`Jan 1, 2026 – Present`, `Jan 1, 2025 – Dec 31, 2025`), source badge (`"Custom"` / `"Synced from Tesla"`) with optional author attribution (`updatedBy` when set), expanded season schedules, and **5-decimal rate formatting** (removing the current 4-decimal truncation).
- Display the same calm re-attribution progress banner if `reattribution.status` is `pending`, `running`, or `failed` (with a **Retry** button on failure), plus the `"Sync from Tesla"` action and optional non-destructive Tesla divergence notice.
- Add a clean helper note pointing users to the PWUsage iOS app to create or edit custom rate plans until interactive Web editing is added.

---

## 8. Observability & Diagnostics

All tariff mutation, sync, and re-attribution code follows [`observability.ts`](../../../cmd/next-app/src/lib/observability.ts) conventions so Axiom captures the full lifecycle safely without exposing PII or losing events on Hobby timeouts:

1. **Route scoping & context:**
   - Wrap `/api/site/[id]/tariffs`, `/api/site/[id]/tariffs/[periodId]`, `/api/site/[id]/tariffs/reattribute`, and `/api/cron/reattribute-tariffs` with `observeRoute(...)`, and call `setLogContext({ siteId })` as soon as the site is resolved (or `setLogContext({ siteIds })` at cron completion, matching `heal-gaps/route.ts`).
2. **Checkpoint flushing (`flushLogEvents()`):**
   - Call `flushLogEvents()` at cron start, after each site finishes (or stops on `time-budget`), and inside the `after()` drain so buffered events flush to Axiom even if Vercel terminates a slow invocation early.
   - Emit per-chunk and per-site events rather than per-day events so large backfills stay well under `MAX_EVENTS = 200` per request scope.
3. **Structured lifecycle event catalog:**
   - **Plan timeline edits:**
     - `tariff.period.created`, `tariff.period.updated`, `tariff.period.deleted` (`periodId`, `tariffId`, `source`, `effectiveFrom`, `effectiveTo`, `seasonCount`, `accountId: accountFingerprint(userId)`)
     - `tariff.tesla_sync.divergence_detected` (`latestTariffId`, `activeManualTariffId`, `contentHashChanged`) when Tesla pushes a changed plan while a `'manual'` span covers today
   - **Re-attribution job lifecycle:**
     - `tariff.reattribution.enqueued` (`trigger: 'create' | 'update' | 'delete' | 'retry'`, `fromDate`, `toDate`, `totalDays`, `coalesced`, `accountId: accountFingerprint(userId)`)
     - `tariff.reattribution.site.started` (`trigger: 'after' | 'cron'`, `fromDate`, `toDate`, `totalDays`, `attemptCount`)
     - `tariff.reattribution.chunk` (`chunkDays`, `skippedDays`, `rewrittenDays`, `scanMs`, `rewriteMs`, `remainingMs`, `claimBusy`, `stoppedReason?`)
     - `tariff.reattribution.site.completed` (`trigger: 'after' | 'cron'`, `outcome: 'idle' | 'partial' | 'busy' | 'failed'`, `processedDays`, `updatedDays`, `durationMs`, `attemptCount`, `error?` via `errorFields(err)`)
     - `tariff.reattribution.site.failed` (`level: 'error'`, logged when `attempt_count` reaches terminal threshold `5`, ready for Axiom Monitor alerting)
   - **Cron wrapper (matching `cron.heal-gaps.*`):**
     - `cron.reattribute-tariffs.started`, `cron.reattribute-tariffs.completed` (`checked`, `stopped`, site outcome summaries), `cron.reattribute-tariffs.failed` (`error: errorFields(e)`)
4. **Redaction & safe error storage:**
   - Never log raw `userId`, `email`, raw `Error.message`, tariff JSON payloads, or compressed archive blobs—use `accountFingerprint(userId)` and `errorFields(error)` (`errorName`, `errorCode`, `constraint`, `errorStatus`).
   - Populate `"SiteTariffReattribution".last_error` with sanitized diagnostic summary tokens (`errorName` / `errorCode`, never arbitrary stack traces or credential strings) so returning `lastError` to iOS/Web stays safe as well.

---

## 9. Error Handling & Edge Cases

- **Concurrent edits on shared sites / two devices:** Every write holds `SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE`, records the acting member in `created_by_user_id` / `updated_by_user_id`, preserves untouched neighbor fragments' original `updated_by_user_id` when splitting/trimming, and returns the complete fresh `SiteTariffsTimelineResponse`. Deleting an already-deleted `periodId` returns `404` gracefully so the client reloads the timeline.
- **Member account deletion on shared sites:** Because `created_by_user_id`, `updated_by_user_id`, and `requested_by_user_id` all use `REFERENCES "User"(id) ON DELETE SET NULL`, deleting one site member's account leaves the shared site's rate plan versions, spans, and historical re-attribution intact with `NULL` author attribution (`account-deletion-postgres.test.ts`).
- **Historical day inside a gap:** `resolveTariffForSiteDate` never fails when a day predates the user's earliest configured plan or lands inside a deleted gap; it deterministically picks the nearest prior or earliest plan so telemetry ingestion (`writeDay`) never drops samples.
- **Deleted/reattributed cycle impacts cached bills:** Because `replaceDay` updates `EnergyDayArchive.revision` and regenerates `"EnergyDaySummary"`, existing `readMobileHistoryRevision` ETag/cache checks invalidate automatically. Any active job overlapping a billing cycle triggers `tariffReattribution` banner metadata on bill views.
- **Wrap-around seasons and midnight-crossing periods:** Both server validator (`tariff-timeline.ts`) and Swift `RatePlanDraft` normalize circular month ranges (`Oct..May`) and wrap-around daily periods (`8:00 PM..8:00 AM`) identically, with explicit unit tests covering midnight crossings, year-end season wraparound, `12:00 AM – 12:00 AM` all-day Off-Peak, and leap-year Feb 29 boundaries (`2024-02-29`).
- **Tesla sync during an active manual plan:** `TariffRepo.addTariffVersion` records a new `'tesla'` tariff version only when its hash differs from the prior `'tesla'` version, leaves `'manual'` spans and `is_current` untouched, and does not trigger unwanted re-attribution.

---

## 10. Verification & Testing Strategy

1. **Database migration & constraint tests (`cmd/next-app`):**
   - Verify backfill on sample sites creates expected `'tesla'` `"TariffEffectivePeriod"` spans (`created_by_user_id` / `updated_by_user_id` `NULL`) without queuing unnecessary re-attribution.
   - Verify `btree_gist` exclusion constraint rejects overlapping intervals and `GRANT ALL ON SEQUENCE "TariffEffectivePeriod_id_seq" TO service_role` + `tariff_current_uidx (site_id)` are applied idempotently.
   - Verify full `"Site"` deletion and `"User"` account deletion (`account-deletion-postgres.test.ts`, with `"TariffEffectivePeriod"` and `"SiteTariffReattribution"` seeded) succeed cleanly with `TariffEffectivePeriod.tariff_id ON DELETE CASCADE` and `ON DELETE SET NULL` user FKs without triggering FK cascade-order errors.
   - Verify [`sanitize-dev-copy.sql`](../../../cmd/next-app/scripts/sanitize-dev-copy.sql) resets any `'pending'` / `'running'` rows in `"SiteTariffReattribution"` to `'idle'`.
2. **Next.js unit & integration tests (`vitest`):**
   - Pure timeline math: span split (enclosing `[2024-01-01, NULL]` split by manual `[2025-01-01, 2025-12-31]`), left/right trim, full overwrite, manual delete restoring fallback, `is_current` invariant.
   - Validation tests: 12-month coverage (including wraparound `Oct -> May`), 48-slot 24h coverage, 5-decimal rounding bounds, rejection of gaps/overlaps/invalid rates.
   - `TariffRepo.addTariffVersion`: verifies `'tesla'` changes do not overwrite `'manual'` spans covering today and deduplicate against the last `'tesla'` version rather than manual `is_current`.
   - Re-attribution engine: verifies metadata-only phase skips rows already matching `timelineRevision` + `segments`, updates rows whose `tariff_id` or `segments` changed while preserving telemetry samples, stops cleanly when the mocked wall-clock time budget is reached while preserving `cursor_day_start`, drains across multiple ticks, coalesces overlapping concurrent edits, transitions `pending -> running -> idle` / `failed`, and emits expected sanitized `logEvent` lifecycle entries (`tariff.reattribution.*`, `cron.reattribute-tariffs.*`, `accountFingerprint` / `errorFields`).
   - Regression test using Harrison's real 2025 and 2026 We Energies rates (`0.27006`/`0.30084` + riders, `0.04906`/`0.03290`, etc.) to confirm exact 5-decimal storage and bill totals without floating-point/cent rounding loss.
3. **iOS unit tests (`swift test` / Xcode `PWUsageTests`, Swift Testing `import Testing`):**
   - Pure tests for `RatePlanDraft` validation (12-month coverage, 24h wraparound periods, 30-min snapping constraints), 5-decimal `RateFormatting` & input parser, DTO round-trip encoding/decoding, and editor actions (`addSeason`, `removeSeason`, `addTimePeriod`, boundary drags).
4. **Linting & builds:**
   - `cmd/next-app`: typecheck (`tsc --noEmit`), lint, unit tests, Next.js build.
   - `cmd/ios-app`: `./cmd/ios-app/lint.sh` (zero SwiftLint violations with `--strict`) and `xcodebuild` test/build verification.
