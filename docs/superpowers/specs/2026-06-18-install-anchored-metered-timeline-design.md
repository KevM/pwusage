# Install-Date Anchored Metered Timeline — Design

**Date:** 2026-06-18
**Status:** Design approved (brainstorm), pending spec review
**Branch context:** `feat/roi`. Follow-on to [2026-06-18-metered-plan-history-design.md](./2026-06-18-metered-plan-history-design.md). That work fed all metered versions into the savings timeline, stamped detection-date `effective_from` on new versions, backfilled later versions, and added a "Metered plan history" manager. This design **replaces the `null` ("from the beginning") earliest-version concept** with a concrete floor anchored at the site's commissioning date, dissolving the two-null / ordering-trap problem class that commits `a8b734a` and `70b225a` were guarding against.

## Problem

The earliest metered `Tariff` version carries `effective_from = null` ("from the beginning"). The prior backfill (`20260618070751_metered_effective_from_backfill.sql`) intentionally leaves it null, and the importer stamps `null` on a site's first version. Consequences observed in testing:

- **Every site currently has exactly one metered version, all null-dated** (verified against the dev DB: 34 sites, all `version = 1`, `effective_from IS NULL`). So the backfill was a no-op everywhere.
- The "Metered plan history" card shows a standing **⚠️ "Please set your current plan's start date first before adding historic plans"** and disables **Add historic plan** whenever any version is null (`hasUndated`). This presents the perfectly-valid default state (single plan, undated) as if it were broken.
- We genuinely cannot honestly *date* a first/only version from Tesla data — Tesla's tariff payload carries the current rates, never a "this plan started on X" date. The only signal, `Tariff.updated` (sync/detection time), is months-to-years after the plan actually began and would mis-price all history before it.

## Key insight

We **do** have an honest, reliable anchor: **`Site.installed`** — the Tesla `installation_date`, a `NOT NULL` column on every `Site`, populated on every sync at [importer/index.ts:327](../../cmd/next-app/src/lib/importer/index.ts). Dev-DB values are real commissioning dates (2020–2022).

Two facts make it the right floor:

1. **It is pricing-neutral.** Our earliest 5-minute `EnergyData` begins ~2026 (years after install). There is no energy before the install date — so anchoring the earliest version at `installed`, at first-energy, or at `null` (−∞) all price **identically**. `pickByDate` ([plan-timeline.ts:28](../../cmd/next-app/src/lib/roi/plan-timeline.ts)) already carries the earliest version backward (treats `null` as `0000-01-01`), so giving it a concrete date changes nothing in the pricing engine.
2. **It reads truthfully** to a human ("your plan, since your system came online") and gives the row a concrete value the UI and ordering guard can rely on — removing the need for the `null` special case entirely.

> **Note on feature reach:** the historic-plan feature only *re-prices* something when a plan switch falls **inside the energy-data window** (~2026 onward). A switch in 2023 has no data to re-price. This is an inherent property of the data, not a limitation of this design; it sets expectations, not scope.

## Goal

Make `Site.installed` the **universal timeline floor** for metered (non-reporting) versions. No metered version is ever `null` again. Replace the `null`-driven warning/guard machinery with a simple monotonic-ordering invariant, and give the manager a clean one-date "add historic plan" flow plus per-version edit.

**Invariant (this design establishes and maintains):** within a site's metered lineage, versions are **strictly date-ordered**, and the **earliest version's `effective_from` equals `Site.installed`** (the floor). There are **no `null` metered `effective_from` values**.

**Scope:** metered (non-reporting) versions only. **Comparison plans (`reporting_only`) are untouched** — they own their own dates and may still be `null`/carry-back.

## Architecture

```
Tesla site_info.installation_date ──► Site.installed (NOT NULL, already persisted)
        │
        ├─ Importer: first metered version stamped effective_from = install date (site-local)
        │            (versions > 1 keep detection-date stamping, as today)
        │
        ├─ Backfill migration: earliest still-null metered version ← Site.installed::date
        │
        └─ Metered plan history manager (MeteredTariffEditor)
             ├─ Add historic plan: rates + ONE switch date
             │     → insert new plan anchored at install (new oldest)
             │     → bump previously-oldest version's effective_from to the switch date
             ├─ Edit version: reopen ScheduleEditor; replace rates + date (ordering-validated)
             │     (Tesla current version: date-only; rates stay Tesla's)
             └─ no null state ⇒ no warning, no disabled button
```

The pricing path (`meteredTimeline` → `scheduleTimeline` → `pickByDate`) is **unchanged**; it already date-resolves and carries the earliest backward.

## Components

### 1. Anchoring — importer (`addTariffVersion`)

`tariff-repo.ts` `addTariffVersion(siteId, parsed, detectionDate)` gains the site's install date so the **first** version can be stamped with it:

- `version === 1` ⇒ `effective_from = installDate` (site-local, `localDateKey(installation_date, tz)`).
- `version > 1` ⇒ `effective_from = detectionDate` (unchanged — a Tesla-detected change is best dated to when we saw it).

The importer ([importer/index.ts:336](../../cmd/next-app/src/lib/importer/index.ts)) already has `info.installation_date` and `info.installation_time_zone` in scope; it passes the site-local install date alongside the detection date.

### 2. Anchoring — backfill migration

New idempotent migration (generated via `npm run db:migration:create`): set each metered version that is still `null` and is its site's earliest to `Site.installed::date`.

```sql
UPDATE "Tariff" t
SET effective_from = s.installed::date
FROM "Site" s
WHERE t.site_id = s.id
  AND NOT t.reporting_only
  AND t.effective_from IS NULL
  AND t.version = (
    SELECT MIN(m.version) FROM "Tariff" m
    WHERE m.site_id = t.site_id AND NOT m.reporting_only
  );
```

Idempotent: once set, the row is no longer null, so a re-run is a no-op. Exact `::date` rounding is immaterial (years before any data). After this migration plus the prior detection-date backfill, **no metered version is null**.

### 3. Add-historic flow (one date, composable)

`MeteredTariffEditor` "Add historic plan" collects **rates + one date** — the *switch date* (when the user moved onto the next-newer plan). The repo performs an atomic insert-and-bump (replacing the current `addHistoricMeteredVersion`, which took a raw `effective_from`):

1. Identify the previously-oldest metered version (minimum `effective_from`, currently the install anchor).
2. Insert the new plan: `reporting_only = false`, `is_current = false`, named after the current metered plan, `effective_from = Site.installed::date` (it becomes the new oldest/floor).
3. Update the previously-oldest version's `effective_from = switchDate`.

Both writes in one transaction. Walking back through several plans (A→B→C) is just repeated application: each add prepends a new oldest at the install anchor and dates the boundary to the next plan.

**Validation:** `switchDate` becomes the previously-oldest version's new `effective_from`, so it must be **after** the install date and **before** the date of the version that currently follows the previously-oldest (or before today, if it has no successor). This keeps the lineage strictly ordered. Coverage validation (full-day/full-week/full-year) is reused from `tou-coverage.ts` `coverageError`, as today.

### 4. Edit a version (rates + date)

Reopen a user-authored version in the route-agnostic `ScheduleEditor`, seeded with its existing seasons + effective date; save **replaces** its season/schedule structure and its `effective_from`.

- **User-authored historic versions:** full edit (rates + date).
- **Tesla current version:** **date-only** — its rates are Tesla's and stay read-only; only its boundary date is adjustable.
- **Ordering-validated:** an edited date must keep the lineage strictly ordered with the oldest pinned at the install floor. This monotonic check **replaces** the two-null PATCH guard (`70b225a`) and the historic-entry ordering guard (`a8b734a`).

New repo capability: replace a metered version's seasons/schedules (a delete-children-and-reinsert within a transaction) plus its date — distinct from `addHistoricMeteredVersion` (which inserts a new version).

### 5. UI / guard retirement

`MeteredTariffEditor`:

- Remove `hasUndated`, the ⚠️ warning, and the disabled **Add historic plan** button.
- Each version row shows its concrete `effective_from`. The oldest reads as the install-anchored floor (e.g. "since 2020-01-15"); no more "from the beginning" / "undated".
- Add an **Edit** affordance per version that opens the `ScheduleEditor` (date-only for the Tesla current version).

## Data flow

1. **Sync:** importer upserts `Site` (sets `installed`), and on first tariff stamps `effective_from = install date`; on a detected change inserts a new version dated to detection.
2. **Backfill (once):** legacy null earliest versions get the install date.
3. **Add historic:** user supplies rates + switch date → transaction inserts at install anchor and bumps the previous oldest.
4. **Edit:** user reopens a version → transaction replaces its structure/date (ordering-validated).
5. **Read/price:** `meteredTimeline` consumes all non-reporting versions (already wired via `listMeteredVersions`); `pickByDate` resolves each hour to the version in effect. Unchanged.

## Error handling & edge cases

- **Install date wrong / rate plan genuinely started later:** the oldest version's date is editable; the user can correct the floor. It must remain ≤ the next version's date and is never cleared to `null` (clearing snaps back to the install date).
- **Non-monotonic edit/add:** rejected with a clear message; the lineage stays strictly ordered.
- **Coverage gap in a historic/edited TOU plan:** rejected via `coverageError`, as today.
- **No delete this iteration:** a mistaken historic entry is corrected by *editing* it (rates + date), not removed. The version *count* cannot shrink without a follow-up — accepted limitation.
- **Comparison plans:** never touched by the importer stamp, the backfill, or the metered manager.

## Testing strategy

- **Importer:** version 1 stamped with site-local install date; version > 1 stamped with detection date.
- **Backfill migration:** earliest null metered version → `Site.installed::date`; second run is a no-op; a multi-version site only fills the earliest; comparison plans untouched.
- **Add-historic:** transaction inserts the new plan at the install anchor and bumps the previously-oldest to the switch date; a switch date outside `(install, nextVersion)` is rejected; pricing of the windows before/after the switch matches hand arithmetic.
- **Edit:** rates+date replace correctly for a user-authored version; the Tesla current version rejects rate edits but accepts a date change; a non-monotonic date is rejected.
- **Regression:** a single-version site prices identically before and after anchoring (install anchor ≡ prior null behavior through `pickByDate`).
- **Guard retirement:** no remaining reader depends on a `null` metered `effective_from`; build/lint/types pass.

## Out of scope

- **Delete** of a metered version (corrected by edit; possible follow-up).
- Authoring brand-new TOU topologies from scratch (clone-and-tweak only, per the matrix design).
- Any change to comparison-plan dating or the bill view (`energy-repo` stays current-rate).
- Sub-hour TOU windows.

## Files (anticipated)

**Modify:**
- `cmd/next-app/src/lib/tariff-repo.ts` — install-date param on `addTariffVersion`; replace `addHistoricMeteredVersion` with insert-and-bump; add replace-version (edit) method.
- `cmd/next-app/src/lib/importer/index.ts` — pass site-local install date.
- `cmd/next-app/src/app/api/site/[id]/metered-tariff/route.ts` — add-historic one-date semantics + edit (PUT); ordering validation.
- `cmd/next-app/src/components/site/MeteredTariffEditor.tsx` — retire warning/guard; one-date add flow; per-version edit.
- Associated `.test.ts(x)` files.

**Create:**
- `cmd/next-app/db-migrations/<timestamp>_metered_install_anchor_backfill.sql`.
