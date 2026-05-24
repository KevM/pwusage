# Append-only tariff versioning (retire the tariff-ID remap)

**Date:** 2026-05-24
**Branch:** `todo-review`
**Status:** Approved design

## Problem

TODO item #4 ("harden tariff ID remap race window in importer") asks us to close a
race in the energy importer. Investigating it surfaced that the remap is a symptom
of a deeper design flaw, and that a worse latent bug rides alongside it.

### Root cause: Tariff rows are deleted while `EnergyData` depends on them

`Tariff.id` is a `SERIAL` surrogate key. When Tesla's tariff content changes,
`TariffRepo.replaceTariffsForSite` (`cmd/next-app/src/lib/tariff-repo.ts`) does a
full **delete-and-reinsert**: it `DELETE`s every `Tariff`/`TariffSeason`/
`TariffSchedule` row for the site and re-inserts a fresh tree. The re-inserted
tariff gets a brand-new `id` even when its name/content is identical.

Two failures follow from that delete:

1. **FK-violation race (the TODO item).** The importer stamps each `EnergyData`
   row's `tariff_id` from an in-memory `site.tariffs` snapshot taken earlier
   (`processHistory`). If `replaceTariffsForSite` commits between the snapshot and
   `insertEnergyDataBatch`, the stamped IDs are now orphaned → FK violation.
   `Importer.remapTariffIds` works around this by re-resolving stale IDs to current
   ones by name before inserting.

2. **Cascade history-wipe (latent, worse).** `EnergyData.tariff_id` references
   `Tariff(id)` with **`ON DELETE CASCADE`** (verified in production). So
   `replaceTariffsForSite`'s `DELETE FROM "Tariff"` cascade-deletes the site's
   **entire `EnergyData` history** on every tariff-content change. It has not
   bitten visibly only because tariff content is stable (every site currently has
   exactly one tariff row), but it is a loaded gun.

Both failures are two faces of one act: **deleting Tariff rows that `EnergyData`
points at.** The remap only papers over face (1); face (2) is unaddressed.

### Production corpus validation (PostgreSQL 17.6)

Read-only checks against production informed this design:

- 25 sites, 25 tariffs (**exactly 1 per site**), 49 seasons, 173 schedules.
- `EnergyData.tariff_id` FK delete action = `CASCADE` (`c`); `tariff_schedule_id`
  FK = `SET NULL` (`n`).
- **0** `(timestamp, site_id)` pairs reference more than one `tariff_id` → the
  `EnergyData` unique key can be safely tightened to `(timestamp, site_id)`.
- Schedule `name` is **not** unique within a season (`OFF_PEAK` appears 5× in one
  season), confirming there is no natural key at the schedule level. NULLs in the
  schedule window columns are pervasive and semantic (`from_hour=NULL` = "from
  midnight", not `0`), so a schedule-level natural key would require a
  `NULLS NOT DISTINCT` window signature.

## Approach

Make tariff content **append-only and versioned at the `Tariff` root**. A version
is an immutable, complete snapshot of the whole tariff tree (`Tariff` + all
`TariffSeason` + all `TariffSchedule`) as it existed at one point in time. Nothing
is ever deleted.

This eliminates the deletion that causes both failures:

- The importer's snapshotted `tariff_id` always still exists → no FK violation →
  **`remapTariffIds` becomes unnecessary and is removed.**
- No `DELETE` of Tariff rows → no cascade → **`EnergyData` history is never wiped.**
- Old `TariffSchedule` rows survive → `EnergyData.tariff_schedule_id` is no longer
  null-wiped on every refresh.
- The `NULLS NOT DISTINCT` schedule-signature work is avoided entirely.

### Version granularity: `Tariff` only

`version` and `is_current` live **only on `Tariff`**. Seasons and schedules carry
no version columns; they are identified by which tariff version they descend from
(`tariff_id → season_id`). Rationale:

- Change detection is whole-blob (`tariff_content_v2`), never a per-schedule delta,
  so we always have a complete new tree to snapshot — there is nothing to attach a
  finer-grained version to.
- Snapshots are immutable and internally consistent; a child never drifts from its
  parent's version.
- "How did this schedule change over time?" is answered by walking the site's
  tariff versions in order and diffing their schedule subtrees — no schedule-level
  version columns required.
- Versioning at the season/schedule level would re-introduce the no-natural-key
  problem (window-signature key + per-schedule diff) for zero added capability.

### When a new version is created

A new version is appended **only when the parsed tariff structure differs from the
current version** — never on an unchanged sync, never twice for the same content.
Two layers guard this:

1. **Cheap pre-filter (existing):** `ensureSite` canonical-compares the raw
   `tariff_content_v2` JSON and skips the tariff write when unchanged.
2. **Authoritative idempotency guard (new):** `addTariffVersion` compares the
   incoming parsed tariff's `content_hash` against the current (`is_current`)
   version's stored hash; if identical, it is a no-op. This prevents version bloat
   from a raw-JSON change the parser ignores. (Existing rows have a NULL hash,
   which the JSON pre-filter already covers — they get a hash on the first genuine
   content change after deploy.)

So version count exactly tracks the number of distinct tariff structures Tesla has
sent.

## Schema migration (idempotent)

New migration file `db-migrations/<timestamp>_tariff_versioning.sql`:

1. **`Tariff`** — add columns:
   - `version INTEGER NOT NULL DEFAULT 1`
   - `is_current BOOLEAN NOT NULL DEFAULT true`
   - `content_hash TEXT` — deterministic hash of the parsed tariff structure;
     realizes the idempotency guard (see below) without re-reading the child tree.
   - Drop `UNIQUE(site_id, name)`; add `UNIQUE(site_id, name, version)` (no version
     collisions; also gives concurrency safety — two simultaneous appends both try
     the same next version, one wins and the other retries).
   - Add partial unique index `UNIQUE(site_id, name) WHERE is_current` (exactly one
     current version per named tariff). This partial index **doubles as the access
     path** for the `SiteRepo` read join (`t.site_id = s.id AND t.is_current`): it
     contains only current rows, keyed by `site_id`. No separate `is_current` index
     is needed (a standalone boolean index would be poorly selective), and the
     all-versions `tariffMap` lookup (`WHERE site_id=$1`) is served by the
     `UNIQUE(site_id, name, version)` index. `Tariff` is tiny (~25 rows), so this is
     forward-proofing as versions accrue, not a current bottleneck.
   - Existing rows default to `version=1, is_current=true`.

2. **`EnergyData`** — replace `UNIQUE(timestamp, site_id, tariff_id)` with
   `UNIQUE(timestamp, site_id)`. Validated safe (0 conflicting pairs). This is also
   a correctness fix: one reading per instant per site; `tariff_id` is derived
   metadata, not identity. **The `tariff_id` column itself is retained** — it stays
   `NOT NULL REFERENCES Tariff(id)`, is still populated on every insert, and is
   still used by billing/aggregation (`GROUP BY tariff_id` and `tariffMap`
   name-resolution in `energy-repo.ts`). Only the constraint changes.

3. **FK** — `EnergyData.tariff_id ON DELETE CASCADE` is **left as-is** (see Risks).

Use `CREATE UNIQUE INDEX IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` and guarded constraint drops so the migration is re-runnable.

## Code changes

### `TariffRepo` (`cmd/next-app/src/lib/tariff-repo.ts`)

- Replace `replaceTariffsForSite` with **`addTariffVersion(siteId, parsed)`**
  (append-only). In one transaction:
  1. Load the current version's parsed structure; if it equals `parsed`, return
     (idempotency guard).
  2. `UPDATE "Tariff" SET is_current=false WHERE site_id=$1 AND is_current`.
  3. `version = COALESCE(MAX(version),0)+1` for the site.
  4. Insert the new `Tariff(version, is_current=true)` + its seasons + schedules.
  5. **No deletes.**
- The idempotency guard reads the current version's full tree (tariff + seasons +
  schedules) to compare against `parsed`.
- `getTariffsForSite` is only called by `remapTariffIds` (being removed) and its
  tests; it becomes unused. Remove it, or repurpose it for the idempotency-guard
  read.

### `SiteRepo` (`cmd/next-app/src/lib/site-repo.ts`) — the critical read path

`site.tariffs` (used app-wide and by the importer's `Schedule`) is built in
`loadSitesFromDB` via `LEFT JOIN "Tariff" t ON t.site_id = s.id`
(`site-repo.ts:109`). This join **must** filter to the current version — add
`AND t.is_current` to the join condition — otherwise `Schedule` would be assembled
from every historical version at once. This is the hot read path; the `is_current`
boolean keeps it a cheap filter. `version` remains queryable separately for
historical lookback.

### `EnergyRepo` (`cmd/next-app/src/lib/energy-repo.ts`)

- `insertEnergyDataBatch` — change the upsert conflict target to
  `ON CONFLICT(timestamp, site_id) DO UPDATE SET tariff_id = EXCLUDED.tariff_id,
  tariff_schedule_id = EXCLUDED.tariff_schedule_id, <power columns…>`. Re-imports
  now update in place and self-heal `tariff_id` to the current version — no
  cross-version duplicate rows.

- **Split the two uses of `site.tariffs` in the billing read** (currently both
  built from `site.tariffs` at `energy-repo.ts:140-154`):
  - The pricing **`Schedule`** continues to use `site.tariffs` (now current-only
    after the `SiteRepo` filter) — correct, since pricing is current-version.
  - The **name-resolution `tariffMap`** (`tariffMap.get(row.tariff_id)`) must be
    built from **all versions** of the site's tariffs (a cheap
    `SELECT id, name FROM "Tariff" WHERE site_id=$1`). Historical `EnergyData` rows
    keep an older version's `tariff_id` (they are never re-imported), so a
    current-only map would resolve them to `'Unknown'` and leave `data.tariff`
    null. This is the one read that genuinely needs every version.

### Importer (`cmd/next-app/src/lib/importer/index.ts`)

- **Delete `remapTariffIds`** and its two call sites (`persistHistory`,
  `loadInterval`); insert the filtered rows directly. Remove the 3 remap tests.
- `ensureSite` — unchanged detection logic; call `addTariffVersion` instead of
  `replaceTariffsForSite`.

## Data flow after the change

Tesla content changes → `ensureSite` detects the JSON diff → `addTariffVersion`
runs its idempotency guard, then appends v2 and flips v1 to `is_current=false`
(v1's rows and the `EnergyData` pointing at them stay) → reads use v2 via
`WHERE is_current` → the importer stamps new `EnergyData` with whatever version it
snapshotted; overlap re-imports converge to v2 through the `(timestamp, site_id)`
upsert. History is never lost; pricing uses the current version.

## Testing (TDD — write failing first)

- **`addTariffVersion` appends, never deletes:** after a change, the old version's
  rows still exist with `is_current=false`; the new one has `is_current=true` and
  `version` incremented.
- **No history loss:** insert `EnergyData`, trigger a tariff change, assert every
  `EnergyData` row survives (the test that fails today due to cascade).
- **Idempotency guard:** calling `addTariffVersion` with content identical to the
  current version is a no-op (no new version row).
- **Re-import across a version boundary:** the same `(timestamp, site_id)` yields
  one row whose `tariff_id` is updated to the current version (no duplicate).
- **`getTariffsForSite` returns only `is_current`.**
- **Historical name resolution:** with `EnergyData` rows referencing a
  non-current tariff version, the billing aggregation still resolves their tariff
  name (all-versions `tariffMap`) rather than falling back to `'Unknown'`.
- **Concurrency:** two `addTariffVersion` calls for one site — the
  `UNIQUE(site_id, name, version)` / partial-unique constraints let one win; the
  other errors and can retry.
- **Remap removal regression:** the importer inserts correctly when its in-memory
  `site.tariffs` snapshot is stale relative to the DB.

## Risks

- **`EnergyData.tariff_id ON DELETE CASCADE` remains.** Harmless while nothing
  deletes Tariff rows, but a future code path that deletes a tariff (e.g. version
  pruning) would still cascade-delete history. Optional future hardening: change it
  to `ON DELETE RESTRICT`. Out of scope here by decision.
- **Version growth** is unbounded in principle but trivial in practice (tables are
  tiny; appends happen only on genuine content changes). Pruning is deferred.

## Files touched

- `cmd/next-app/db-migrations/<timestamp>_tariff_versioning.sql` — new migration.
- `cmd/next-app/src/lib/tariff-repo.ts` — `addTariffVersion`; remove
  `getTariffsForSite` (or repurpose for the idempotency guard).
- `cmd/next-app/src/lib/site-repo.ts` — `AND t.is_current` on the tariff join in
  `loadSitesFromDB` (the hot read path).
- `cmd/next-app/src/lib/energy-repo.ts` — `(timestamp, site_id)` upsert target;
  build the name-resolution `tariffMap` from all versions (Schedule stays current).
- `cmd/next-app/src/lib/importer/index.ts` — remove `remapTariffIds`; call
  `addTariffVersion`.
- Test files for the above (new versioning tests; remove remap tests).

## Follow-up

Once landed, remove TODO item #4 ("harden tariff ID remap race window in
importer") and delete the already-resolved item #5 ("TRMNL chart hour labels
should use site timezone", fixed in PR #61) from `TODO.md`.

## Out of scope

- **Version-aware (temporal) pricing.** Pricing uses the current version only;
  `EnergyData` rows from prior eras keep a valid FK anchor but are priced via the
  current tariff at read time. Per-era pricing is a separate, deferrable change.
- **Changing the `EnergyData.tariff_id` FK delete action** (see Risks).
- **Old-version pruning / GC.**
- **A schedule-level natural key / `NULLS NOT DISTINCT` window signature** — not
  needed under root-level versioning.
