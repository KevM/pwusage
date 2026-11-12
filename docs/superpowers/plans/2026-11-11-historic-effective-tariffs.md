# Historic Effective-Dated Rate Plans, Re-attribution Engine & Native Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add effective-dated rate plans with user-authored override precedence, bounded newest-first server re-attribution of compact energy history, Axiom observability, Web read-only timeline display, and a native SwiftUI Tesla-style editor supporting up to 5 decimal places.

**Architecture:** Preserve append-only `"Tariff"` -> `"TariffSeason"` -> `"TariffSchedule"` rows (`DesignDecisions.md` §2) and add `"Tariff".source`, `"Tariff".created_by_user_id`, `"TariffEffectivePeriod"` (non-overlapping site-local `[effective_from, effective_to]` spans), and `"SiteTariffReattribution"` (per-site bounded job cursor). Re-attribution runs newest-first in small checkpointed chunks inside a `35_000 ms` cron soft budget (`50_000 ms` `withIoDeadline`) skipping payload decodes when `timelineRevision` and segments already match, while iOS + Web cut over directly to the v2 `/api/site/[id]/tariffs` contract.

**Tech Stack:** Next.js 15+ App Router, TypeScript (`pg` / PostgreSQL, `vitest`), Axiom (`@axiomhq/js`), SwiftUI + `@Observable` + Swift Testing (`import Testing`), XcodeGen / SwiftLint (`--strict`).

**Design Spec:** [`docs/superpowers/specs/2026-11-11-historic-effective-tariffs-design.md`](../specs/2026-11-11-historic-effective-tariffs-design.md)

## Global Constraints

- **Append-only tariff tables:** Never update in-place or delete rows in `"Tariff"`, `"TariffSeason"`, or `"TariffSchedule"` referenced by `"EnergyDaySummary"`.
- **Shared-site user deletion safety:** All `User(id)` foreign keys on tariff/period/re-attribution tables use `ON DELETE SET NULL`.
- **No TypeScript `any`:** Strict interfaces for every parameter and return value in `cmd/next-app`.
- **Never hand-create SQL migration filenames:** Always generate migrations via `npm run db:migration:create <name>` from `cmd/next-app`.
- **Rate precision:** Preserve `DOUBLE PRECISION` end-to-end and allow 0 to 5 decimal places (`<= 10.0`, `>= 0`).
- **Voice and terms (`docs/voice-and-terms.md`):** UI strings use *"Rate Plan"*, *"Rate Period"*, *"Buy"*, *"Sell"* (never *"tariff"*, *"tariff period"*, *"TOU"*, exclamation marks, *"please"*, or *"sorry"*); use middle dot (`·`) for metadata separators.
- **iOS SwiftLint budget:** Zero warnings/errors under `./cmd/ios-app/lint.sh` (`--strict`): max 120 chars/line, 400/500 lines/file, 50/100 lines/function body, no `!` or `try!`, `@MainActor` + `Sendable`.
- **Observability privacy:** Use `accountFingerprint(userId)` and `errorFields(error)` in logs; never log raw emails, user IDs, raw `Error.message`, tokens, or archive payloads.

---

## Task 1: Database Schema Migration & DB Types

**Files:**
- Generate via CLI: `cmd/next-app/db-migrations/<ts>_historic_effective_tariffs.sql`
- Generate via CLI: `cmd/next-app/db-migrations/<ts>_reattribute_tariffs_cron.sql`
- Modify: `cmd/next-app/src/lib/db-types.ts:49-83`
- Modify: `cmd/next-app/scripts/sanitize-dev-copy.sql`
- Modify: `cmd/next-app/src/lib/account-deletion-postgres.test.ts`
- Test: `cmd/next-app/src/lib/tariff-effective-migration-postgres.test.ts`

**Interfaces:**
- Produces SQL tables/columns/indexes:
  - `"Tariff"`: `source TEXT NOT NULL DEFAULT 'tesla' CHECK (source IN ('tesla', 'manual'))`, `created_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL`, and tightened partial unique index `tariff_current_uidx ON "Tariff"(site_id) WHERE is_current`
  - `"TariffEffectivePeriod"`: `(id, site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id, created_at)` (`tariff_id` uses `ON DELETE CASCADE`, sequence grant `GRANT ALL ON SEQUENCE "TariffEffectivePeriod_id_seq" TO service_role`) + `tariff_effective_period_no_overlap` GIST exclusion constraint
  - `"SiteTariffReattribution"`: `(site_id, status, generation, from_date, to_date, cursor_day_start, total_days, processed_days, updated_days, attempt_count, last_error, requested_by_user_id, updated_at)`
- Produces TypeScript interfaces in `cmd/next-app/src/lib/db-types.ts`: `Tariff` (`source`, `created_by_user_id`, `version`, `is_current`, `content_hash`), `TariffEffectivePeriodRow`, `SiteTariffReattributionRow` (`generation: number`)

- [ ] **Step 1: Generate the two empty migration shells with the repo generator**

Run from `cmd/next-app`:
```bash
npm run db:migration:create historic_effective_tariffs
npm run db:migration:create reattribute_tariffs_cron
```
Expected: Two timestamped SQL files created inside `cmd/next-app/db-migrations/` containing the standard RLS boilerplate comments.

- [ ] **Step 2: Write the failing Postgres migration & cascade test**

Create `cmd/next-app/src/lib/tariff-effective-migration-postgres.test.ts`:
```ts
import { afterAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { createActivityTestDatabase } from './battery-hold-activity-test-db';

describe('historic_effective_tariffs migration (postgres)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('backfills active tesla tariff spans, rejects overlapping intervals, and clears author refs on user delete', async () => {
    const dbHandle = await createActivityTestDatabase();
    cleanup = dbHandle.close;
    const db = dbHandle.pool;

    await db.query(`
      CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE "Site" (id TEXT PRIMARY KEY, user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL, timezone TEXT NOT NULL);
      CREATE TABLE "Tariff" (
        id SERIAL PRIMARY KEY,
        site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
        updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        name TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        is_current BOOLEAN NOT NULL DEFAULT true,
        content_hash TEXT
      );
      CREATE TABLE "EnergyDayArchive" (
        site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
        day_start TIMESTAMPTZ NOT NULL,
        revision UUID NOT NULL,
        PRIMARY KEY (site_id, day_start)
      );
    `);

    await db.query(`INSERT INTO "User" (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')`);
    await db.query(`INSERT INTO "Site" (id, user_id, timezone) VALUES ('s1', 'u1', 'America/Chicago')`);
    const t1 = (await db.query<{ id: number }>(
      `INSERT INTO "Tariff" (site_id, name, version, is_current, content_hash) VALUES ('s1', 'We energies', 1, true, 'h1') RETURNING id`
    )).rows[0].id;
    await db.query(
      `INSERT INTO "EnergyDayArchive" (site_id, day_start, revision) VALUES ('s1', '2025-01-15T06:00:00Z', '00000000-0000-0000-0000-000000000001')`
    );

    const migFile = (await readdir('db-migrations')).find(f => f.endsWith('_historic_effective_tariffs.sql'));
    if (!migFile) throw new Error('Migration missing');
    const sql = await readFile(`db-migrations/${migFile}`, 'utf8');
    await db.query(sql);
    await db.query(sql); // idempotent re-run

    const periods = (await db.query(
      `SELECT tariff_id, effective_from::text, effective_to::text, source, updated_by_user_id FROM "TariffEffectivePeriod" WHERE site_id = 's1'`
    )).rows;
    expect(periods).toEqual([
      { tariff_id: t1, effective_from: '2025-01-15', effective_to: null, source: 'tesla', updated_by_user_id: null },
    ]);

    const t2 = (await db.query<{ id: number }>(
      `INSERT INTO "Tariff" (site_id, name, version, is_current, content_hash, source, created_by_user_id)
       VALUES ('s1', 'Manual', 2, false, 'h2', 'manual', 'u2') RETURNING id`
    )).rows[0].id;

    // GIST constraint rejects overlapping range on the same site.
    await expect(
      db.query(
        `INSERT INTO "TariffEffectivePeriod" (site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id)
         VALUES ('s1', $1, '2025-06-01', '2025-12-31', 'manual', 'u2')`,
        [t2]
      )
    ).rejects.toThrow(/tariff_effective_period_no_overlap/);

    // Deleting creator/editor user preserves Tariff, period, and job row with NULL user refs.
    await db.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = 's1'`);
    await db.query(
      `INSERT INTO "TariffEffectivePeriod" (site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id)
       VALUES ('s1', $1, '2025-01-01', '2025-12-31', 'manual', 'u2')`,
      [t2]
    );
    await db.query(
      `INSERT INTO "SiteTariffReattribution" (site_id, status, from_date, requested_by_user_id) VALUES ('s1', 'pending', '2025-01-01', 'u2')`
    );
    await db.query(`DELETE FROM "User" WHERE id = 'u2'`);

    const tariffAfter = (await db.query(`SELECT created_by_user_id FROM "Tariff" WHERE id = $1`, [t2])).rows[0];
    const periodAfter = (await db.query(`SELECT updated_by_user_id FROM "TariffEffectivePeriod" WHERE site_id = 's1'`)).rows[0];
    const jobAfter = (await db.query(`SELECT requested_by_user_id FROM "SiteTariffReattribution" WHERE site_id = 's1'`)).rows[0];
    expect(tariffAfter.created_by_user_id).toBeNull();
    expect(periodAfter.updated_by_user_id).toBeNull();
    expect(jobAfter.requested_by_user_id).toBeNull();

    // Tightened unique index allows at most one is_current row per site even across different names.
    await expect(
      db.query(
        `INSERT INTO "Tariff" (site_id, name, version, is_current, content_hash, source)
         VALUES ('s1', 'Another Plan', 3, true, 'h3', 'manual')`
      )
    ).rejects.toThrow(/tariff_current_uidx/);

    // Deleting Site cascades cleanly through Tariff -> TariffEffectivePeriod without FK trigger-order failure.
    await expect(db.query(`DELETE FROM "Site" WHERE id = 's1'`)).resolves.toBeDefined();
    expect((await db.query(`SELECT 1 FROM "TariffEffectivePeriod" WHERE site_id = 's1'`)).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM "SiteTariffReattribution" WHERE site_id = 's1'`)).rowCount).toBe(0);
  });
});
```

Also update `cmd/next-app/src/lib/account-deletion-postgres.test.ts` to include `"TariffEffectivePeriod"` and `"SiteTariffReattribution"` rows in its schema + fixture setup so account/site deletion cascade ordering stays continuously regression-tested.

- [ ] **Step 3: Run test to verify it fails**

Run from `cmd/next-app`: `npm test -- --run src/lib/tariff-effective-migration-postgres.test.ts`
Expected: FAIL because the generated migration file is still empty.

- [ ] **Step 4: Populate the two SQL migrations and update `db-types.ts`**

Append to the generated `*_historic_effective_tariffs.sql` migration (keeping its generated header/RLS boilerplate):
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Tariff"
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tesla',
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_source_check') THEN
    ALTER TABLE "Tariff"
      ADD CONSTRAINT tariff_source_check CHECK (source IN ('tesla', 'manual'));
  END IF;
END $$;

-- Deduplicate any pre-existing sites with multiple is_current rows across different names before tightening the index.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY site_id ORDER BY id DESC) AS rn
  FROM "Tariff"
  WHERE is_current = TRUE
)
UPDATE "Tariff" t
SET is_current = FALSE
FROM ranked r
WHERE t.id = r.id AND r.rn > 1;

DROP INDEX IF EXISTS tariff_current_uidx;
CREATE UNIQUE INDEX tariff_current_uidx ON "Tariff" (site_id) WHERE is_current;

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_effective_period_no_overlap') THEN
    ALTER TABLE "TariffEffectivePeriod"
      ADD CONSTRAINT tariff_effective_period_no_overlap
      EXCLUDE USING gist (
        site_id WITH =,
        daterange(effective_from, COALESCE((effective_to + INTERVAL '1 day')::date, 'infinity'::date), '[)') WITH &&
      );
  END IF;
END $$;

ALTER TABLE "TariffEffectivePeriod" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "TariffEffectivePeriod" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "TariffEffectivePeriod" TO service_role;
GRANT ALL ON SEQUENCE "TariffEffectivePeriod_id_seq" TO service_role;

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

ALTER TABLE "SiteTariffReattribution" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SiteTariffReattribution" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "SiteTariffReattribution" TO service_role;

-- Backfill one open-ended 'tesla' effective period for sites with a current tariff and none yet recorded.
INSERT INTO "TariffEffectivePeriod" (site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id)
SELECT
  t.site_id,
  t.id,
  COALESCE(
    (
      SELECT (MIN(a.day_start) AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date
      FROM "EnergyDayArchive" a
      WHERE a.site_id = s.id
    ),
    (now() AT TIME ZONE COALESCE(s.timezone, 'UTC'))::date
  ),
  NULL,
  'tesla',
  NULL
FROM "Tariff" t
JOIN "Site" s ON s.id = t.site_id
WHERE t.is_current = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM "TariffEffectivePeriod" p WHERE p.site_id = t.site_id
  );
```

Populate the generated `*_reattribute_tariffs_cron.sql` migration (gated in SQL so idle minutes issue zero HTTP requests, zero Vercel invocations, and zero Axiom events):
```sql
SELECT cron.schedule(
  'reattribute-tariffs-trigger',
  '* * * * *',
  $$
  SELECT net.http_get(
    url := target.url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
    ),
    timeout_milliseconds := 65000
  )
  FROM (
    SELECT regexp_replace(decrypted_secret, '/api/cron/restore-reserve$', '/api/cron/reattribute-tariffs') AS url
    FROM vault.decrypted_secrets WHERE name = 'battery_restore_cron_target_url' LIMIT 1
  ) target
  WHERE target.url LIKE 'https://%/api/cron/reattribute-tariffs'
    AND EXISTS (
      SELECT 1 FROM public."SiteTariffReattribution"
      WHERE status = 'pending'
         OR (status = 'running' AND updated_at < now() - interval '2 minutes')
    );
  $$
);
```

Also update `cmd/next-app/scripts/sanitize-dev-copy.sql` (inside its `DO $$` block) so restoring a prod dump onto dev resets mid-flight re-attribution jobs without firing workers on beta:
```sql
IF to_regclass('public."SiteTariffReattribution"') IS NOT NULL THEN
  EXECUTE 'UPDATE public."SiteTariffReattribution" SET status = ''idle'', cursor_day_start = NULL WHERE status IN (''pending'', ''running'')';
END IF;
```

Update `Tariff` and add `TariffEffectivePeriodRow` / `SiteTariffReattributionRow` in `cmd/next-app/src/lib/db-types.ts`:
```ts
export type TariffSource = 'tesla' | 'manual';

export interface Tariff {
  id: number;
  site_id: string;
  updated: Date;
  name: string | null;
  version?: number;
  is_current?: boolean;
  content_hash?: string | null;
  source?: TariffSource;
  created_by_user_id?: string | null;
  seasons?: TariffSeason[];
}

export interface TariffEffectivePeriodRow {
  id: number;
  site_id: string;
  tariff_id: number;
  effective_from: string;
  effective_to: string | null;
  source: TariffSource;
  updated_by_user_id: string | null;
  created_at: Date;
}

export type TariffReattributionStatus = 'pending' | 'running' | 'idle' | 'failed';

export interface SiteTariffReattributionRow {
  site_id: string;
  status: TariffReattributionStatus;
  generation: number;
  from_date: string;
  to_date: string | null;
  cursor_day_start: Date | null;
  total_days: number;
  processed_days: number;
  updated_days: number;
  attempt_count: number;
  last_error: string | null;
  requested_by_user_id: string | null;
  updated_at: Date;
}
```

- [ ] **Step 5: Run Postgres migration test & commit**

Run: `npm test -- --run src/lib/tariff-effective-migration-postgres.test.ts src/lib/account-deletion-postgres.test.ts`
Expected: PASS
```bash
git add db-migrations/*historic_effective_tariffs.sql db-migrations/*reattribute_tariffs_cron.sql scripts/sanitize-dev-copy.sql src/lib/db-types.ts src/lib/tariff-effective-migration-postgres.test.ts src/lib/account-deletion-postgres.test.ts
git commit -m "feat(db): add effective-dated tariff periods and reattribution state tables"
```

---

## Task 2: Timeline Validation, Schedule Compiler & Pure Span Math (`cmd/next-app`)

**Files:**
- Create: `cmd/next-app/src/lib/tariff-timeline.ts`
- Modify: `cmd/next-app/src/lib/schedule.ts` (extract/export pure `sortSchedulesBySpecificity` and `matchesScheduleForDay` so `decompileTariffToSeasons` shares `Schedule`'s exact specificity logic without duplication)
- Modify: `cmd/next-app/src/lib/tariff-contract.ts` (update cleanly to export v2 timeline DTO types + formatters)
- Test: `cmd/next-app/src/lib/tariff-timeline.test.ts`

**Interfaces:**
- Produces in `tariff-contract.ts`: `SiteTariffsTimelineResponse`, `TariffPeriodDTO`, `TariffSeasonInput`, `TimePeriodWindowInput`, `ReattributionStatusDTO`, `TariffUpdatedByDTO` (`{ email: string | null; isCurrentUser: boolean }`), `TariffPeriodName` (`'ON_PEAK' | 'PARTIAL_PEAK' | 'OFF_PEAK' | 'SUPER_OFF_PEAK'`)
- Produces in `tariff-timeline.ts`:
  - `MAX_EFFECTIVE_PERIODS_PER_SITE = 50`
  - `validateTariffPlanInput(input: TariffPlanWriteInput, todaySiteLocal: string): TariffPlanWriteInput` (throws `TariffValidationError` with `message` and HTTP `status = 400`)
  - `compileSeasonsToParsedTariff(name: string, seasons: TariffSeasonInput[]): ParsedTariff`
  - `decompileTariffToSeasons(tariff: Tariff): TariffSeasonInput[]`
  - `computeSpanMutations(existing: ExistingSpan[], incoming: { tariffId: number; source: TariffSource; effectiveFrom: string; effectiveTo: string | null; updatedByUserId: string | null }): SpanMutationPlan`
  - `siteLocalDateString(date: Date, timezone: string): string` & `addCalendarDays(yyyyMmDd: string, delta: number): string`

- [ ] **Step 1: Write failing unit tests for validation, compile/decompile round-trip, and span mutations**

Create `cmd/next-app/src/lib/tariff-timeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  compileSeasonsToParsedTariff,
  computeSpanMutations,
  decompileTariffToSeasons,
  TariffValidationError,
  validateTariffPlanInput,
} from './tariff-timeline';
import type { TariffSeasonInput } from './tariff-contract';

const weEnergiesSeasons: TariffSeasonInput[] = [
  {
    name: 'Winter',
    fromMonth: 10,
    toMonth: 5,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 },
      { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.31335, sellRate: 0.03863 },
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 },
    ],
  },
  {
    name: 'Summer',
    fromMonth: 6,
    toMonth: 9,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.10279, sellRate: 0.03290 },
      { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.30335, sellRate: 0.04906 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03290 },
    ],
  },
];

describe('validateTariffPlanInput', () => {
  it('accepts valid 5-decimal rates, wraparound seasons, and midnight-crossing windows', () => {
    const validated = validateTariffPlanInput({
      name: '  We Energies Rg2  ',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      seasons: weEnergiesSeasons,
    }, '2026-11-11');
    expect(validated.name).toBe('We Energies Rg2');
    expect(validated.seasons[1].weekdayPeriods[0].buyRate).toBe(0.10279);
  });

  it('rejects > 5 decimal places, missing months, zero-length periods, > 48 periods, or gaps in 24h weekday schedule', () => {
    const badDecimal = structuredClone(weEnergiesSeasons);
    badDecimal[0].weekdayPeriods[0].buyRate = 0.123456;
    expect(() => validateTariffPlanInput({
      name: 'Bad', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: badDecimal,
    }, '2026-11-11')).toThrow(TariffValidationError);

    const missingMonth = structuredClone(weEnergiesSeasons);
    missingMonth[0].toMonth = 4; // drops May
    expect(() => validateTariffPlanInput({
      name: 'Gap', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: missingMonth,
    }, '2026-11-11')).toThrow(/12 months/i);

    const gapHours = structuredClone(weEnergiesSeasons);
    gapHours[1].weekendPeriods = [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 23, toMinute: 30, buyRate: 0.1, sellRate: 0.03 },
    ];
    expect(() => validateTariffPlanInput({
      name: 'GapHour', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: gapHours,
    }, '2026-11-11')).toThrow(/24 hours/i);

    const zeroLength = structuredClone(weEnergiesSeasons);
    zeroLength[1].weekendPeriods = [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 0, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.2, sellRate: 0.03 },
    ];
    expect(() => validateTariffPlanInput({
      name: 'ZeroLen', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: zeroLength,
    }, '2026-11-11')).toThrow(TariffValidationError);

    const tooManyPeriods = structuredClone(weEnergiesSeasons);
    tooManyPeriods[1].weekendPeriods = Array.from({ length: 49 }, (_, i) => ({
      touName: 'OFF_PEAK' as const,
      fromHour: Math.floor((i % 48) / 2),
      fromMinute: (i % 2) * 30,
      toHour: Math.floor(((i % 48) + 1) / 2),
      toMinute: ((i % 48 + 1) % 2) * 30,
      buyRate: 0.1,
      sellRate: 0.03,
    }));
    expect(() => validateTariffPlanInput({
      name: 'TooMany', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: tooManyPeriods,
    }, '2026-11-11')).toThrow(TariffValidationError);
  });
});

describe('compileSeasonsToParsedTariff & decompileTariffToSeasons', () => {
  it('preserves Feb 29 leap-day end boundary and 5-decimal rates round-trip', () => {
    const parsed = compileSeasonsToParsedTariff('Test', [
      {
        name: 'Winter',
        fromMonth: 12,
        toMonth: 2,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 }],
      },
      {
        name: 'Warm',
        fromMonth: 3,
        toMonth: 11,
        weekdayPeriods: [{ touName: 'ON_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.30335, sellRate: 0.04906 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.0329 }],
      },
    ]);
    expect(parsed.seasons[0].to_day).toBe(29);
    const roundTripped = decompileTariffToSeasons({
      id: 1, site_id: 's1', updated: new Date(), name: parsed.name,
      seasons: parsed.seasons.map((s, idx) => ({
        id: idx + 1, tariff_id: 1, ...s,
        schedules: s.schedules.map((sch, j) => ({ id: idx * 10 + j + 1, season_id: idx + 1, ...sch })),
      })),
    });
    expect(roundTripped[0].weekdayPeriods[0].buyRate).toBe(0.10279);
  });

  it('resolves layered Tesla schedules into non-overlapping 24h windows using Schedule specificity', () => {
    const decompiled = decompileTariffToSeasons({
      id: 2,
      site_id: 's1',
      updated: new Date(),
      name: 'Layered Tesla Plan',
      seasons: [{
        id: 10,
        tariff_id: 2,
        name: 'All Year',
        from_month: 1,
        from_day: 1,
        to_month: 12,
        to_day: 31,
        buy_rate: 0.1,
        sell_rate: 0.03,
        schedules: [
          // Every day all-day baseline
          { id: 1, season_id: 10, name: 'OFF_PEAK', buy_rate: 0.1, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 },
          // Narrower Mon-Fri peak override (overlaps 0..6 baseline in raw rows)
          { id: 2, season_id: 10, name: 'ON_PEAK', buy_rate: 0.3, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 4, from_hour: 8, from_minute: 0, to_hour: 20, to_minute: 0 },
        ],
      }],
    });
    expect(decompiled[0].weekdayPeriods).toEqual([
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.3, sellRate: 0.05 },
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
    ]);
    expect(decompiled[0].weekendPeriods).toEqual([
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
    ]);
    expect(() => validateTariffPlanInput({
      name: 'Layered Tesla Plan', effectiveFrom: '2026-01-01', effectiveTo: null, seasons: decompiled,
    }, '2026-11-11')).not.toThrow();
  });
});

describe('computeSpanMutations', () => {
  it('splits an enclosing tesla span around a bounded manual period while keeping untouched author metadata', () => {
    const plan = computeSpanMutations(
      [{ id: 10, tariffId: 82, source: 'tesla', effectiveFrom: '2024-01-01', effectiveTo: null, updatedByUserId: null }],
      { tariffId: 90, source: 'manual', effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', updatedByUserId: 'user-1' }
    );
    expect(plan.deleteIds).toEqual([10]);
    expect(plan.inserts).toEqual([
      { tariffId: 82, source: 'tesla', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31', updatedByUserId: null },
      { tariffId: 90, source: 'manual', effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', updatedByUserId: 'user-1' },
      { tariffId: 82, source: 'tesla', effectiveFrom: '2026-01-01', effectiveTo: null, updatedByUserId: null },
    ]);
    expect(addCalendarDays('2024-02-29', 1)).toBe('2024-03-01');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/lib/tariff-timeline.test.ts`
Expected: FAIL (`Cannot find module './tariff-timeline'`)

- [ ] **Step 3: Implement `tariff-contract.ts` (v2 DTOs) and `tariff-timeline.ts`**

Replace `cmd/next-app/src/lib/tariff-contract.ts`:
```ts
import type { TariffReattributionStatus, TariffSource } from './db-types';

export type TariffPeriodName = 'ON_PEAK' | 'PARTIAL_PEAK' | 'OFF_PEAK' | 'SUPER_OFF_PEAK';

export interface TimePeriodWindowInput {
  touName: TariffPeriodName;
  fromHour: number;
  fromMinute: number;
  toHour: number;
  toMinute: number;
  buyRate: number;
  sellRate: number;
}

export interface TariffSeasonInput {
  name: string;
  fromMonth: number;
  toMonth: number;
  weekdayPeriods: TimePeriodWindowInput[];
  weekendPeriods: TimePeriodWindowInput[];
}

export interface TariffUpdatedByDTO {
  email: string | null;
  isCurrentUser: boolean;
}

export interface TariffPeriodDTO {
  periodId: number;
  tariffId: number;
  name: string;
  version: number;
  source: TariffSource;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrentToday: boolean;
  updatedBy: TariffUpdatedByDTO | null;
  seasons: TariffSeasonInput[];
}

export interface ReattributionStatusDTO {
  status: TariffReattributionStatus;
  fromDate: string;
  toDate: string | null;
  totalDays: number;
  processedDays: number;
  updatedDays: number;
  lastError: string | null;
  updatedAt: string;
}

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
```

Create `cmd/next-app/src/lib/tariff-timeline.ts`:
```ts
import type { Tariff, TariffSchedule, TariffSource } from './db-types';
import type { ParsedSchedule, ParsedSeason, ParsedTariff } from './importer/tariff-parser';
import { matchesScheduleForDay, sortSchedulesBySpecificity } from './schedule';
import type { TariffPeriodName, TariffSeasonInput, TimePeriodWindowInput } from './tariff-contract';

export const MAX_EFFECTIVE_PERIODS_PER_SITE = 50;
const VALID_TOU_NAMES = new Set<TariffPeriodName>(['ON_PEAK', 'PARTIAL_PEAK', 'OFF_PEAK', 'SUPER_OFF_PEAK']);
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TariffPlanWriteInput {
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  seasons: TariffSeasonInput[];
}

export interface ExistingSpan {
  id: number;
  tariffId: number;
  source: TariffSource;
  effectiveFrom: string;
  effectiveTo: string | null;
  updatedByUserId: string | null;
}

export interface NewSpanRow {
  tariffId: number;
  source: TariffSource;
  effectiveFrom: string;
  effectiveTo: string | null;
  updatedByUserId: string | null;
}

export interface SpanMutationPlan {
  deleteIds: number[];
  inserts: NewSpanRow[];
}

export class TariffValidationError extends Error {
  readonly status = 400;
}

export function siteLocalDateString(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function addCalendarDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d + delta);
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function assertValidCalendarDate(value: string, field: string): void {
  if (!ISO_DATE_RE.test(value)) throw new TariffValidationError(`Invalid ${field} format (expected YYYY-MM-DD)`);
  const [y, m, d] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) {
    throw new TariffValidationError(`Invalid calendar date for ${field}`);
  }
}

export function validateEffectiveDates(effectiveFrom: string, effectiveTo: string | null, todaySiteLocal: string): void {
  assertValidCalendarDate(effectiveFrom, 'effectiveFrom');
  if (effectiveTo !== null) {
    assertValidCalendarDate(effectiveTo, 'effectiveTo');
    if (effectiveTo < effectiveFrom) {
      throw new TariffValidationError('effectiveTo must be on or after effectiveFrom');
    }
  }
  if (effectiveFrom < '2015-01-01' || effectiveFrom > addCalendarDays(todaySiteLocal, 365)) {
    throw new TariffValidationError('effectiveFrom is outside allowed date bounds');
  }
}

function checkRate(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
    throw new TariffValidationError(`${label} must be between 0 and 10`);
  }
  const rounded = Math.round(value * 100_000) / 100_000;
  if (Math.abs(value - rounded) > 1e-9) {
    throw new TariffValidationError(`${label} supports at most 5 decimal places`);
  }
  return rounded;
}

function slotIndex(hour: number, minute: number, allow24 = false): number {
  if (!Number.isInteger(hour) || (minute !== 0 && minute !== 30)) {
    throw new TariffValidationError('Period boundaries must use 30-minute increments');
  }
  if (hour === 24 && minute === 0 && allow24) return 48;
  if (hour < 0 || hour > 23) throw new TariffValidationError('Hour out of range (0..23)');
  return hour * 2 + (minute === 30 ? 1 : 0);
}

function validateDaySlots(periods: TimePeriodWindowInput[], label: string): TimePeriodWindowInput[] {
  if (!Array.isArray(periods) || periods.length === 0 || periods.length > 48) {
    throw new TariffValidationError(`${label} must contain 1–48 periods covering 24 hours`);
  }
  const seen = new Array<boolean>(48).fill(false);
  const normalized: TimePeriodWindowInput[] = periods.map(p => {
    if (!VALID_TOU_NAMES.has(p.touName)) {
      throw new TariffValidationError(`Invalid period name: ${p.touName}`);
    }
    const startSlot = slotIndex(p.fromHour, p.fromMinute, false);
    const endSlot = slotIndex(p.toHour, p.toMinute, true);
    const isSingleAllDay = periods.length === 1 && startSlot === 0 && (endSlot === 48 || endSlot === 0);
    if (startSlot === endSlot && !isSingleAllDay) {
      throw new TariffValidationError(`${label} contains a zero-length period`);
    }
    const span = isSingleAllDay ? 48 : (endSlot > startSlot ? endSlot - startSlot : (48 - startSlot) + endSlot);
    for (let offset = 0; offset < span; offset++) {
      const idx = (startSlot + offset) % 48;
      if (seen[idx]) {
        throw new TariffValidationError(`${label} contains overlapping rate periods`);
      }
      seen[idx] = true;
    }
    return {
      touName: p.touName,
      fromHour: p.fromHour,
      fromMinute: p.fromMinute,
      toHour: isSingleAllDay ? 24 : p.toHour,
      toMinute: isSingleAllDay ? 0 : p.toMinute,
      buyRate: checkRate(p.buyRate, 'buyRate'),
      sellRate: checkRate(p.sellRate, 'sellRate'),
    };
  });
  if (seen.some(v => !v)) {
    throw new TariffValidationError(`${label} must cover all 24 hours without gaps`);
  }
  return normalized;
}

export function validateTariffPlanInput(input: TariffPlanWriteInput, todaySiteLocal: string): TariffPlanWriteInput {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 64) {
    throw new TariffValidationError('Rate plan name must be 1–64 characters');
  }
  validateEffectiveDates(input.effectiveFrom, input.effectiveTo, todaySiteLocal);
  if (!Array.isArray(input.seasons) || input.seasons.length < 1 || input.seasons.length > 6) {
    throw new TariffValidationError('Rate plan must include 1–6 seasons');
  }
  const monthOwners = new Array<boolean>(12).fill(false);
  const seasons: TariffSeasonInput[] = input.seasons.map(season => {
    const seasonName = typeof season.name === 'string' ? season.name.trim() : '';
    if (!seasonName || seasonName.length > 64) {
      throw new TariffValidationError('Each season must have a 1–64 character name');
    }
    if (!Number.isInteger(season.fromMonth) || season.fromMonth < 1 || season.fromMonth > 12
      || !Number.isInteger(season.toMonth) || season.toMonth < 1 || season.toMonth > 12) {
      throw new TariffValidationError('Season months must be integers in 1..12');
    }
    let m = season.fromMonth;
    for (let guard = 0; guard < 12; guard++) {
      if (monthOwners[m - 1]) {
        throw new TariffValidationError('Seasons must cover all 12 months without overlap');
      }
      monthOwners[m - 1] = true;
      if (m === season.toMonth) break;
      m = (m % 12) + 1;
    }
    return {
      name: seasonName,
      fromMonth: season.fromMonth,
      toMonth: season.toMonth,
      weekdayPeriods: validateDaySlots(season.weekdayPeriods, `${seasonName} weekday schedule`),
      weekendPeriods: validateDaySlots(season.weekendPeriods, `${seasonName} weekend schedule`),
    };
  });
  if (monthOwners.some(v => !v)) {
    throw new TariffValidationError('Seasons must cover all 12 months without gaps');
  }
  return { name, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, seasons };
}

function toParsedSchedules(windows: TimePeriodWindowInput[], fromDow: number, toDow: number): ParsedSchedule[] {
  const out: ParsedSchedule[] = [];
  for (const w of windows) {
    const startMin = w.fromHour * 60 + w.fromMinute;
    const endMin = w.toHour * 60 + w.toMinute;
    if (startMin === 0 && endMin === 1440) {
      out.push({
        name: w.touName, buy_rate: w.buyRate, sell_rate: w.sellRate,
        from_day_of_week: fromDow, to_day_of_week: toDow,
        from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
      });
    } else if (endMin > startMin) {
      out.push({
        name: w.touName, buy_rate: w.buyRate, sell_rate: w.sellRate,
        from_day_of_week: fromDow, to_day_of_week: toDow,
        from_hour: w.fromHour, from_minute: w.fromMinute, to_hour: w.toHour, to_minute: w.toMinute,
      });
    } else {
      // Split midnight-crossing windows cleanly for unambiguous SQL inspection while Schedule supports both.
      out.push({
        name: w.touName, buy_rate: w.buyRate, sell_rate: w.sellRate,
        from_day_of_week: fromDow, to_day_of_week: toDow,
        from_hour: w.fromHour, from_minute: w.fromMinute, to_hour: 24, to_minute: 0,
      });
      if (endMin > 0) {
        out.push({
          name: w.touName, buy_rate: w.buyRate, sell_rate: w.sellRate,
          from_day_of_week: fromDow, to_day_of_week: toDow,
          from_hour: 0, from_minute: 0, to_hour: w.toHour, to_minute: w.toMinute,
        });
      }
    }
  }
  return out;
}

export function compileSeasonsToParsedTariff(name: string, seasons: TariffSeasonInput[]): ParsedTariff {
  const parsedSeasons: ParsedSeason[] = seasons.map(season => {
    const allWindows = [...season.weekdayPeriods, ...season.weekendPeriods];
    const minBuy = Math.min(...allWindows.map(w => w.buyRate));
    const minSell = Math.min(...allWindows.map(w => w.sellRate));
    const schedules: ParsedSchedule[] = [
      ...toParsedSchedules(season.weekdayPeriods, 0, 4),
      ...toParsedSchedules(season.weekendPeriods, 5, 6),
    ];
    return {
      name: season.name,
      from_month: season.fromMonth,
      from_day: 1,
      to_month: season.toMonth,
      to_day: MONTH_MAX_DAYS[season.toMonth - 1],
      buy_rate: minBuy,
      sell_rate: minSell,
      schedules,
    };
  });
  return { name, seasons: parsedSeasons };
}

function normalizeTouName(raw: string | null | undefined): TariffPeriodName {
  if (raw && VALID_TOU_NAMES.has(raw as TariffPeriodName)) return raw as TariffPeriodName;
  return 'OFF_PEAK';
}

function resolveDayWindows(
  sortedSchedules: TariffSchedule[],
  jsWeekday: number,
  fallbackBuy: number,
  fallbackSell: number
): TimePeriodWindowInput[] {
  const slots = Array.from({ length: 48 }, (_, slot) => {
    const hour = Math.floor(slot / 2);
    const minute = (slot % 2) * 30;
    const match = sortedSchedules.find(sch => matchesScheduleForDay(jsWeekday, hour, minute, sch));
    return {
      touName: normalizeTouName(match?.name),
      buyRate: match?.buy_rate ?? fallbackBuy,
      sellRate: match?.sell_rate ?? fallbackSell,
    };
  });

  const windows: TimePeriodWindowInput[] = [];
  for (let slot = 0; slot < 48; slot++) {
    const cur = slots[slot];
    const prev = windows[windows.length - 1];
    if (prev && prev.touName === cur.touName && prev.buyRate === cur.buyRate && prev.sellRate === cur.sellRate) {
      prev.toHour = Math.floor((slot + 1) / 2);
      prev.toMinute = ((slot + 1) % 2) * 30;
    } else {
      windows.push({
        touName: cur.touName,
        fromHour: Math.floor(slot / 2),
        fromMinute: (slot % 2) * 30,
        toHour: Math.floor((slot + 1) / 2),
        toMinute: ((slot + 1) % 2) * 30,
        buyRate: cur.buyRate,
        sellRate: cur.sellRate,
      });
    }
  }
  return windows;
}

export function decompileTariffToSeasons(tariff: Tariff): TariffSeasonInput[] {
  return (tariff.seasons ?? []).map(season => {
    const sorted = sortSchedulesBySpecificity(season.schedules ?? []);
    return {
      name: season.name || 'Season',
      fromMonth: season.from_month,
      toMonth: season.to_month,
      // Canonical Monday (JS 1 -> Tesla 0) and Saturday (JS 6 -> Tesla 5) resolve layered Tesla rules into clean windows.
      weekdayPeriods: resolveDayWindows(sorted, 1, season.buy_rate, season.sell_rate),
      weekendPeriods: resolveDayWindows(sorted, 6, season.buy_rate, season.sell_rate),
    };
  });
}

function cmpEnd(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function spansOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  if (aTo !== null && aTo < bFrom) return false;
  if (bTo !== null && bTo < aFrom) return false;
  return true;
}

export function computeSpanMutations(
  existing: ExistingSpan[],
  incoming: NewSpanRow
): SpanMutationPlan {
  const deleteIds: number[] = [];
  const fragments: NewSpanRow[] = [];

  for (const span of existing) {
    if (!spansOverlap(span.effectiveFrom, span.effectiveTo, incoming.effectiveFrom, incoming.effectiveTo)) {
      continue;
    }
    deleteIds.push(span.id);
    if (span.effectiveFrom < incoming.effectiveFrom) {
      fragments.push({
        tariffId: span.tariffId,
        source: span.source,
        effectiveFrom: span.effectiveFrom,
        effectiveTo: addCalendarDays(incoming.effectiveFrom, -1),
        updatedByUserId: span.updatedByUserId,
      });
    }
    if (incoming.effectiveTo !== null && cmpEnd(span.effectiveTo, incoming.effectiveTo) > 0) {
      fragments.push({
        tariffId: span.tariffId,
        source: span.source,
        effectiveFrom: addCalendarDays(incoming.effectiveTo, 1),
        effectiveTo: span.effectiveTo,
        updatedByUserId: span.updatedByUserId,
      });
    }
  }

  return { deleteIds, inserts: [...fragments, incoming] };
}
```

In `cmd/next-app/src/lib/schedule.ts`, extract pure `export function sortSchedulesBySpecificity(schedules: TariffSchedule[]): TariffSchedule[]` and `export function matchesScheduleForDay(jsWeekday: number, hour: number, minute: number, schedule: TariffSchedule): boolean` from `Schedule`'s existing methods and call them from both `Schedule` and `decompileTariffToSeasons`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --run src/lib/tariff-timeline.test.ts src/lib/schedule.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule.ts src/lib/tariff-contract.ts src/lib/tariff-timeline.ts src/lib/tariff-timeline.test.ts
git commit -m "feat(tariffs): add v2 timeline contracts, schedule validation, and span math"
```

---

## Task 3: Timeline Repository, `is_current` Invariant & Tesla Sync Coexistence (`cmd/next-app`)

**Files:**
- Create: `cmd/next-app/src/lib/tariff-timeline-repo.ts`
- Modify: `cmd/next-app/src/lib/tariff-repo.ts:47-118`
- Test: `cmd/next-app/src/lib/tariff-timeline-repo.test.ts`
- Modify tests if broken: check `cmd/next-app/src/lib/tariff-repo.test.ts`

**Interfaces:**
- Consumes: `MAX_EFFECTIVE_PERIODS_PER_SITE`, `TariffPlanWriteInput`, `compileSeasonsToParsedTariff`, `decompileTariffToSeasons`, `computeSpanMutations`, `siteLocalDateString`, `addCalendarDays` (`tariff-timeline.ts`); `tariffContentHash` (`importer/tariff-parser.ts`); `SiteRepo.invalidateCache` (`site-repo.ts`); `logEvent` (`observability.ts`)
- Produces in `tariff-timeline-repo.ts`:
  - `TariffTimelineRepo` class:
    - `getTimeline(siteId: string, viewerUserId: string | null): Promise<SiteTariffsTimelineResponse>`
    - `createManualPeriod(siteId: string, userId: string, input: TariffPlanWriteInput): Promise<SiteTariffsTimelineResponse>`
    - `updatePeriod(siteId: string, periodId: number, userId: string, patch: Partial<TariffPlanWriteInput>): Promise<SiteTariffsTimelineResponse>`
    - `deleteManualPeriod(siteId: string, periodId: number, userId: string): Promise<{ timeline: SiteTariffsTimelineResponse; removedRange: { fromDate: string; toDate: string } }>`
    - `resolveTariffForDate(client: PoolClient, siteId: string, siteLocalDate: string): Promise<{ tariffs: Tariff[]; schedules: TariffSchedule[] }>`

- [ ] **Step 1: Write failing Postgres integration tests for `TariffTimelineRepo` & updated `TariffRepo.addTariffVersion`**

Create `cmd/next-app/src/lib/tariff-timeline-repo.test.ts` (using `createActivityTestDatabase` with mock `observability` or spy) testing:
1. Creating a historical manual period (`2025-01-01 .. 2025-12-31`) splits an existing open-ended `'tesla'` span (`2024-01-01 .. NULL`), preserves `updated_by_user_id = NULL` on `'tesla'` fragments, keeps `'tesla'` as `is_current = true`, and records `created_by_user_id = userId` on the new manual tariff.
2. Updating `'manual'` period rates creates a new immutable `"Tariff"` version (`version` incremented) **including when sharing the same `(site_id, name)`**, keeps the old `"Tariff"` row intact, demotes before promoting so `tariff_current_uidx` never trips, and enforces `MAX_EFFECTIVE_PERIODS_PER_SITE`.
3. Calling `TariffRepo.addTariffVersion` when a manual plan covers `today` saves the new `'tesla'` tariff (`source = 'tesla'`) ONLY if its hash differs from the prior `'tesla'` version, keeps the manual tariff `is_current = true` and untouched, flags `teslaSync.differsFromActiveManual = true`, and invalidates `SiteRepo` cache.
4. Calling `deleteManualPeriod` removes only the period row (not the `"Tariff"` row), coalesces/heals abutting `'tesla'` spans for the same `tariff_id`, promotes the latest `'tesla'` span if today became uncovered, and returns `removedRange`.

```ts
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';

const local = vi.hoisted(() => ({ database: undefined as unknown as import('pg').Pool }));
vi.mock('./db', () => ({ pool: {
  query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
  connect: () => local.database.connect(),
} }));

import { TariffRepo } from './tariff-repo';
import { TariffTimelineRepo } from './tariff-timeline-repo';
import { createActivityTestDatabase } from './battery-hold-activity-test-db';

describe('TariffTimelineRepo & Tesla sync precedence (postgres)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('splits existing tesla span, protects active manual plan from tesla overwrite, and preserves immutable rows on delete', async () => {
    const handle = await createActivityTestDatabase();
    cleanup = handle.close;
    local.database = handle.pool;

    await local.database.query(`
      CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE "Site" (id TEXT PRIMARY KEY, user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL, timezone TEXT NOT NULL, json JSONB);
      CREATE TABLE "Tariff" (
        id SERIAL PRIMARY KEY, site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
        updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, name TEXT, version INTEGER NOT NULL DEFAULT 1,
        is_current BOOLEAN NOT NULL DEFAULT true, content_hash TEXT
      );
      CREATE TABLE "TariffSeason" (
        id SERIAL PRIMARY KEY, tariff_id INTEGER NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE,
        name TEXT, from_month INTEGER NOT NULL, from_day INTEGER NOT NULL, to_month INTEGER NOT NULL, to_day INTEGER NOT NULL,
        buy_rate DOUBLE PRECISION NOT NULL, sell_rate DOUBLE PRECISION NOT NULL
      );
      CREATE TABLE "TariffSchedule" (
        id SERIAL PRIMARY KEY, season_id INTEGER NOT NULL REFERENCES "TariffSeason"(id) ON DELETE CASCADE,
        name TEXT, buy_rate DOUBLE PRECISION, sell_rate DOUBLE PRECISION,
        from_day_of_week INTEGER, from_hour INTEGER, from_minute INTEGER, to_day_of_week INTEGER, to_hour INTEGER, to_minute INTEGER
      );
      CREATE TABLE "EnergyDayArchive" (site_id TEXT NOT NULL, day_start TIMESTAMPTZ NOT NULL, revision UUID NOT NULL, PRIMARY KEY (site_id, day_start));
      INSERT INTO "User" VALUES ('u1', 'owner@example.com'), ('u2', 'member@example.com');
      INSERT INTO "Site" VALUES ('s1', 'u1', 'America/Chicago', '{"currency":"USD"}');
    `);

    const migFile = (await readdir('db-migrations')).find(f => f.endsWith('_historic_effective_tariffs.sql'));
    if (!migFile) throw new Error('Migration missing');
    await local.database.query(await readFile(`db-migrations/${migFile}`, 'utf8'));

    const tariffRepo = new TariffRepo();
    await tariffRepo.addTariffVersion('s1', {
      name: 'Utility Rounded',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.1, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.1, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });

    const repo = new TariffTimelineRepo();
    // Add manual 2026-onward tariff by shared user u2
    await repo.createManualPeriod('s1', 'u2', {
      name: 'Exact 2026',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      seasons: [{
        name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.10279, sellRate: 0.03289 }],
      }],
    });

    // Tesla reports a changed rounded tariff: must NOT overwrite manual current period
    await tariffRepo.addTariffVersion('s1', {
      name: 'Utility Rounded v2',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.11, sell_rate: 0.04,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.11, sell_rate: 0.04, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });

    const timeline = await repo.getTimeline('s1', 'u1');
    const active = timeline.periods.find(p => p.isCurrentToday);
    expect(active?.name).toBe('Exact 2026');
    expect(active?.source).toBe('manual');
    expect(active?.updatedBy).toEqual({ email: 'member@example.com', isCurrentUser: false });
    expect(timeline.teslaSync.differsFromActiveManual).toBe(true);

    // Deleting manual span keeps Tariff row in DB and restores active tesla coverage
    const manualPeriodId = active!.periodId;
    await repo.deleteManualPeriod('s1', manualPeriodId, 'u1');
    const afterDelete = await repo.getTimeline('s1', 'u1');
    expect(afterDelete.periods.find(p => p.isCurrentToday)?.source).toBe('tesla');
    const manualTariffStillExists = await local.database.query(`SELECT id FROM "Tariff" WHERE site_id = 's1' AND name = 'Exact 2026'`);
    expect(manualTariffStillExists.rowCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/lib/tariff-timeline-repo.test.ts`
Expected: FAIL (`Cannot find module './tariff-timeline-repo'`)

- [ ] **Step 3: Implement `tariff-timeline-repo.ts` and update `tariff-repo.ts`**

Create `cmd/next-app/src/lib/tariff-timeline-repo.ts` with shared helpers `insertTariffGraph` and `recomputeIsCurrentTariff`:
```ts
import type { PoolClient } from 'pg';
import { pool } from './db';
import type { Tariff, TariffSchedule, TariffSeason, TariffSource } from './db-types';
import { tariffContentHash, type ParsedTariff } from './importer/tariff-parser';
import { accountFingerprint, logEvent } from './observability';
import type { SiteTariffsTimelineResponse, TariffPeriodDTO } from './tariff-contract';
import {
  addCalendarDays,
  compileSeasonsToParsedTariff,
  computeSpanMutations,
  decompileTariffToSeasons,
  siteLocalDateString,
  TariffValidationError,
  validateEffectiveDates,
  validateTariffPlanInput,
  type ExistingSpan,
  type TariffPlanWriteInput,
} from './tariff-timeline';

export async function insertTariffGraph(
  client: PoolClient,
  siteId: string,
  parsed: ParsedTariff,
  source: TariffSource,
  createdByUserId: string | null,
  isCurrent: boolean,
  contentHash = tariffContentHash(parsed)
): Promise<number> {
  const verRes = await client.query<{ next: number }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM "Tariff" WHERE site_id = $1',
    [siteId]
  );
  const tariffId = (await client.query<{ id: number }>(
    `INSERT INTO "Tariff"(site_id, name, version, is_current, content_hash, source, created_by_user_id, updated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id`,
    [siteId, parsed.name, verRes.rows[0].next, isCurrent, contentHash, source, createdByUserId]
  )).rows[0].id;

  for (const season of parsed.seasons) {
    const seasonId = (await client.query<{ id: number }>(
      `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [tariffId, season.name, season.from_month, season.from_day, season.to_month, season.to_day, season.buy_rate, season.sell_rate]
    )).rows[0].id;
    for (const sch of season.schedules) {
      await client.query(
        `INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [seasonId, sch.name, sch.buy_rate, sch.sell_rate, sch.from_day_of_week, sch.to_day_of_week, sch.from_hour, sch.from_minute, sch.to_hour, sch.to_minute]
      );
    }
  }
  return tariffId;
}

export async function recomputeIsCurrentTariff(client: PoolClient, siteId: string, todaySiteLocal: string): Promise<number | null> {
  const active = await client.query<{ tariff_id: number }>(
    `SELECT tariff_id FROM "TariffEffectivePeriod"
     WHERE site_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
     ORDER BY effective_from DESC LIMIT 1`,
    [siteId, todaySiteLocal]
  );
  const fallback = active.rows[0]?.tariff_id ?? (await client.query<{ tariff_id: number }>(
    `SELECT tariff_id FROM "TariffEffectivePeriod" WHERE site_id = $1 ORDER BY effective_from DESC LIMIT 1`,
    [siteId]
  )).rows[0]?.tariff_id ?? null;
  if (fallback === null) return null;
  // Demote before promoting so non-deferrable partial unique index tariff_current_uidx never trips on scan order.
  await client.query(
    'UPDATE "Tariff" SET is_current = FALSE WHERE site_id = $1 AND is_current = TRUE AND id <> $2',
    [siteId, fallback]
  );
  await client.query(
    'UPDATE "Tariff" SET is_current = TRUE WHERE id = $1 AND is_current = FALSE',
    [fallback]
  );
  return fallback;
}
```
Also implement `TariffTimelineRepo` in the same file:
- `getTimeline(siteId, viewerUserId)`: loads `"Site"`, `"TariffEffectivePeriod"` joined with `"Tariff"` and optional `"User"` (`creator`/`editor`, projecting `updatedBy: { email, isCurrentUser }` with no `userId`), `"TariffSeason"`, `"TariffSchedule"`, latest `'tesla'` tariff vs current `'manual'` tariff for `teslaSync`, and latest `"SiteTariffReattribution"` row.
- `createManualPeriod(siteId, userId, input)`: validates `validateTariffPlanInput`, locks `"Site"`, inserts new immutable `'manual'` tariff via `insertTariffGraph`, applies `computeSpanMutations` to overlapping spans (preserving `updated_by_user_id` on untouched fragments), asserts total `"TariffEffectivePeriod"` rows for `siteId` `<= MAX_EFFECTIVE_PERIODS_PER_SITE`, runs `recomputeIsCurrentTariff`, logs `tariff.period.created` (`accountId: accountFingerprint(userId)`), commits, calls `new SiteRepo().invalidateCache(siteId)`, returns `getTimeline`.
- `updatePeriod(siteId, periodId, userId, patch)`: rejects `name`/`seasons` changes when `period.source === 'tesla'` (`TariffValidationError`); for `'manual'`, only inserts a new immutable `"Tariff"` version when `tariffContentHash(compiled)` differs from the existing tariff's `content_hash`; deletes `periodId` and inserts `[newFrom, newTo]` with `computeSpanMutations`, heals any abutting `'tesla'` spans with matching `tariff_id` if the range shrank, asserts `<= MAX_EFFECTIVE_PERIODS_PER_SITE`, runs `recomputeIsCurrentTariff`, commits, calls `new SiteRepo().invalidateCache(siteId)`, logs `tariff.period.updated`.
- `deleteManualPeriod(siteId, periodId, userId)`: returns `null`/throws 404 if missing, `TariffValidationError` (400) if `source === 'tesla'`; deletes only the `"TariffEffectivePeriod"` row; heals abutting `'tesla'` spans sharing the same `tariff_id` across the removed gap (or, if `today` has no span and a `'tesla'` tariff exists, inserts/extends `[todaySiteLocal, nextSpanMinus1]` for the latest `'tesla'` tariff); runs `recomputeIsCurrentTariff`, commits, calls `new SiteRepo().invalidateCache(siteId)`, logs `tariff.period.deleted`.
- `resolveTariffForDate(client, siteId, siteLocalDate)`: resolves exact covering span -> nearest prior span -> earliest site span -> `is_current = TRUE`, returning `{ tariffs, schedules }` hydrated cleanly.

Update `cmd/next-app/src/lib/tariff-repo.ts` (calling `new SiteRepo().invalidateCache(siteId)` after `COMMIT` whenever spans/tariffs changed):
```ts
// Inside TariffRepo.addTariffVersion(siteId: string, parsed: ParsedTariff):
const newHash = tariffContentHash(parsed);
// Lock Site row FOR UPDATE
const latestTesla = (await client.query<{ id: number; content_hash: string | null }>(
  `SELECT id, content_hash FROM "Tariff" WHERE site_id = $1 AND source = 'tesla' ORDER BY id DESC LIMIT 1`,
  [siteId]
)).rows[0];
if (latestTesla?.content_hash === newHash) {
  await client.query('COMMIT');
  return;
}
const newTariffId = await insertTariffGraph(client, siteId, parsed, 'tesla', null, false, newHash);
const siteTz = (await client.query<{ timezone: string }>('SELECT timezone FROM "Site" WHERE id = $1', [siteId])).rows[0]?.timezone ?? 'UTC';
const today = siteLocalDateString(new Date(), siteTz);
const spans = await loadExistingSpans(client, siteId);
const coveringToday = spans.find(s => s.effectiveFrom <= today && (s.effectiveTo === null || s.effectiveTo >= today));
if (coveringToday?.source === 'manual') {
  logEvent('info', 'tariff.tesla_sync.divergence_detected', {
    latestTariffId: newTariffId, activeManualTariffId: coveringToday.tariffId, contentHashChanged: true,
  });
} else {
  const nextManual = spans.find(s => s.source === 'manual' && s.effectiveFrom > today);
  const effectiveTo = nextManual ? addCalendarDays(nextManual.effectiveFrom, -1) : null;
  await applySpanMutationPlan(client, siteId, computeSpanMutations(spans, {
    tariffId: newTariffId, source: 'tesla', effectiveFrom: today, effectiveTo, updatedByUserId: null,
  }));
  await recomputeIsCurrentTariff(client, siteId, today);
}
// After client.query('COMMIT'):
new SiteRepo().invalidateCache(siteId);
```

- [ ] **Step 4: Run `tariff-timeline-repo.test.ts` and `tariff-repo.test.ts`**

Run: `npm test -- --run src/lib/tariff-timeline-repo.test.ts src/lib/tariff-repo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/tariff-timeline-repo.ts src/lib/tariff-repo.ts src/lib/tariff-timeline-repo.test.ts
git commit -m "feat(tariffs): implement TariffTimelineRepo and manual-precedence Tesla sync"
```

---

## Task 4: Date-Aware `CompactHistoryStore.writeDay`, `timelineRevision` & Time-Budgeted Re-attribution Engine (`cmd/next-app`)

**Files:**
- Modify: `cmd/next-app/src/lib/prototypes/day-attribution.ts` (add `tariffTimelineRevision(tariffId: number): string`)
- Modify: `cmd/next-app/src/lib/prototypes/compact-history-store.ts:285-305,427-456` (replace `this.tariffs(client, siteId, true)` in `writeDay` with date-aware tariff resolution + expose `reattributeDayBatch(...)` or internal helper using existing `replaceDay` & `prepareSamples`)
- Create: `cmd/next-app/src/lib/tariff-reattribution.ts`
- Test: `cmd/next-app/src/lib/tariff-reattribution.test.ts`

**Interfaces:**
- Consumes: `TariffTimelineRepo.resolveTariffForDate`, `deriveDayAttribution`, `buildDayMetadataV3`, `decodeDaySamples`, `encodeDaySamples`, `CompactHistoryStore`, `withIoDeadline`, `logEvent`, `flushLogEvents`, `errorFields`, `accountFingerprint`
- Produces in `tariff-reattribution.ts`:
  - `enqueueTariffReattribution(params: { siteId: string; fromDate: string; toDate: string | null; requestedByUserId: string | null; trigger: 'create' | 'update' | 'delete' | 'retry' }): Promise<ReattributionStatusDTO>`
  - `runSiteReattribution(params: { siteId: string; trigger: 'after' | 'cron'; maxTimeMs?: number; chunkDays?: number; clock?: () => number }): Promise<{ outcome: 'idle' | 'partial' | 'busy' | 'failed'; processedDays: number; updatedDays: number }>`
  - `runPendingReattributionsCron(options?: { maxTimeMs?: number; chunkDays?: number; clock?: () => number }): Promise<{ checked: number; stopped?: 'time-budget'; sites: Array<{ siteId: string; outcome: string; processedDays: number; updatedDays: number }> }>`
  - `getSiteReattributionStatus(siteId: string): Promise<ReattributionStatusDTO | null>`
  - Constants: `REATTRIBUTION_CHUNK_DAYS = 15`, `REATTRIBUTION_MAX_TIME_MS = 35_000`, `REATTRIBUTION_AFTER_MAX_TIME_MS = 6_000`, `REATTRIBUTION_MAX_ATTEMPTS = 5`

- [ ] **Step 1: Write failing tests for date-aware `writeDay`, two-phase skip/rewrite, time-budget stopping, generation fencing, coalescing & retries**

Create `cmd/next-app/src/lib/tariff-reattribution.test.ts` testing:
1. `writeDay` attributes historical `2025-07-15` against the `2025` effective tariff rather than `is_current` (`2026`).
2. `runSiteReattribution` fast-skips legacy rows carrying `"current-tariff:<id>"` (or `"effective-tariff:<id>"`) whenever `segmentsEqual(...) && attribution_complete === expected` without rewriting `revision`, while rewriting rows whose `tariff_id` or segments changed (`tariff_id` + `EnergyDaySummary` updated, telemetry samples bit-exact).
3. Simulated slow clock causes `runSiteReattribution` to stop cleanly at `maxTimeMs` preserving `cursor_day_start`, then finish cleanly on the next tick.
4. Concurrent `enqueueTariffReattribution` widens `[from_date, to_date]`, increments `generation`, resets `cursor_day_start = null`, resets `attempt_count = 0`, and causes an in-flight worker holding the stale `generation` to roll back its chunk write and checkpoint cleanly (`generation` fencing).
5. Failures increment `attempt_count`, store sanitized `errorName`/`errorCode` in `last_error`, and mark `'failed'` at attempt 5.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/lib/tariff-reattribution.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `tariffTimelineRevision`, date-aware `CompactHistoryStore.writeDay`, and `tariff-reattribution.ts`**

1. In `cmd/next-app/src/lib/prototypes/day-attribution.ts`, add:
```ts
export function tariffTimelineRevision(tariffId: number): string {
  return `effective-tariff:${tariffId}`;
}
```
And ensure `deriveDayAttribution(schedule, tariffId, start, end)` sets `timelineRevision: tariffTimelineRevision(tariffId)`.

2. In `cmd/next-app/src/lib/prototypes/compact-history-store.ts`:
   - Inside `writeDay`, compute `const siteLocalDate = siteLocalDateString(start, timezone)` and call `new TariffTimelineRepo().resolveTariffForDate(client, siteId, siteLocalDate)` instead of `this.tariffs(client, siteId, true)`.
   - Add `reattributeArchiveChunk(...)`: takes metadata rows `{ dayStart, dayEnd, attribution, attributionComplete }[]`, computes `nextAttribution` from the effective tariff for each `dayStart`, fast-skips without reading `payload` whenever `segmentsEqual(row.attribution?.segments, nextAttribution.segments) && row.attributionComplete === isAttributionComplete(nextAttribution)` (regardless of whether `timelineRevision` has `'current-tariff:'` or `'effective-tariff:'` prefix), fetches `payload` + `fetched_at` only for changed `day_start` keys, decodes samples via `decodeDaySamples`, builds `prepareSamples(..., targetTariff, fetchedAt, now)`, runs inside the same DB transaction as the fenced `"SiteTariffReattribution"` checkpoint (`generation` check -> rollback if superseded), acquires `claimMutation`, and calls `this.replaceDay(...)`.

3. Create `cmd/next-app/src/lib/tariff-reattribution.ts` with generation-fenced time-budgeted loop & Axiom telemetry:
```ts
export const REATTRIBUTION_CHUNK_DAYS = 15;
export const REATTRIBUTION_MAX_TIME_MS = 35_000;
export const REATTRIBUTION_AFTER_MAX_TIME_MS = 6_000;
export const REATTRIBUTION_MAX_ATTEMPTS = 5;

export async function runSiteReattribution(params: {
  siteId: string;
  trigger: 'after' | 'cron';
  maxTimeMs?: number;
  chunkDays?: number;
  clock?: () => number;
}): Promise<{ outcome: 'idle' | 'partial' | 'busy' | 'failed'; processedDays: number; updatedDays: number }> {
  const clock = params.clock ?? Date.now;
  const maxTimeMs = params.maxTimeMs ?? REATTRIBUTION_MAX_TIME_MS;
  const chunkDays = params.chunkDays ?? REATTRIBUTION_CHUNK_DAYS;
  const startedAt = clock();
  // Read SiteTariffReattribution + claim status = 'running' capturing its monotonic `generation`; emit tariff.reattribution.site.started.
  // Loop while maxTimeMs - (clock() - startedAt) > 0:
  //   scan metadata-only chunk newest-first (ORDER BY day_start DESC LIMIT $chunkDays)
  //   inside one transaction: run two-phase skip/rewrite in CompactHistoryStore, then fence checkpoint:
  //     UPDATE "SiteTariffReattribution" SET processed_days = ..., updated_days = ..., cursor_day_start = ..., status = ...
  //     WHERE site_id = $1 AND generation = $generation
  //   If rowCount === 0: ROLLBACK transaction cleanly (superseded by concurrent edit), emit 'tariff.reattribution.superseded', return.
  //   emit logEvent('info', 'tariff.reattribution.chunk', { chunkDays, skippedDays, rewrittenDays, scanMs, rewriteMs, remainingMs, claimBusy })
  //   flushLogEvents()
  // On error: sanitize diagnostic token (`errorFields(err)`), increment attempt_count (fenced on generation), transition to 'failed' once attempt_count >= 5 + emit 'tariff.reattribution.site.failed'.
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --run src/lib/tariff-reattribution.test.ts src/lib/prototypes/compact-history-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/prototypes/day-attribution.ts src/lib/prototypes/compact-history-store.ts src/lib/tariff-reattribution.ts src/lib/tariff-reattribution.test.ts
git commit -m "feat(history): resolve effective tariff per day and add time-budgeted reattribution engine"
```

---

## Task 5: API Routes, Cron Handler, v2 Cutover & Bill Status Extension (`cmd/next-app`)

**Files:**
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/route.ts` (`GET`, `POST`)
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/[periodId]/route.ts` (`PATCH`, `DELETE`)
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/reattribute/route.ts` (`POST`)
- Create: `cmd/next-app/src/app/api/cron/reattribute-tariffs/route.ts` (`GET` with `maxDuration = 60`, `HARD_DEADLINE_MS = 50_000`)
- Modify: `cmd/next-app/src/app/api/site/[id]/refresh-tariffs/route.ts` (keep `POST` returning `{ success, updatedFromTesla, timeline }`, retire `GET`)
- Modify: `cmd/next-app/src/app/api/mobile/bill-summary/route.ts` (attach optional `tariffReattribution` when active/failed job exists on the site)
- Modify: `cmd/next-app/src/lib/mobile-bill-revision.ts` (hash active/failed `tariffReattribution` `status`, `processedDays`, `updatedDays` into the bill revision so `/api/mobile/bill-summary` never returns stale `304 Not Modified` during/after re-attribution transitions)
- Modify: `cmd/next-app/src/lib/mobile-dashboard-contract.ts` (add optional `tariffReattribution?: ReattributionStatusDTO | null` — remember cross-app sync in Task 7!)
- Test: `cmd/next-app/src/app/api/site/[id]/tariffs/route.test.ts`, `cmd/next-app/src/app/api/cron/reattribute-tariffs/route.test.ts`, `cmd/next-app/src/lib/mobile-bill-revision.test.ts`, & update `cmd/next-app/src/app/api/site/[id]/refresh-tariffs/route.test.ts`

**Interfaces:**
- Auth & CSRF: `getCurrentUser()` + `verifySiteAccess(siteId)` (`src/lib/auth-checks.ts`) on site routes; `if (isCrossOriginRequest(req)) return json({ error: 'Cross-origin requests are not allowed' }, 403);` (`src/lib/request-security.ts`) on every cookie-authenticated mutating route (`POST`/`PATCH`/`DELETE` `/api/site/[id]/tariffs*` and `POST /api/site/[id]/refresh-tariffs`); `CRON_SECRET` Bearer auth on `/api/cron/reattribute-tariffs`.
- Observability: `observeRoute`, `setLogContext`, `logEvent`, `flushLogEvents`, `errorFields`, `accountFingerprint`.
- Scheduling: Next.js `after(() => runSiteReattribution({ siteId, trigger: 'after', maxTimeMs: REATTRIBUTION_AFTER_MAX_TIME_MS }))` inside `withIoDeadline(10_000, ...)`.

- [ ] **Step 1: Write failing route & cron tests**

Create `cmd/next-app/src/app/api/site/[id]/tariffs/route.test.ts` and `cmd/next-app/src/app/api/cron/reattribute-tariffs/route.test.ts` testing:
- `401` / `403` when unauthenticated, unauthorized for `siteId`, or cross-origin browser `Origin` mismatches on `POST` / `PATCH` / `DELETE` (`isCrossOriginRequest`).
- `GET /api/site/[id]/tariffs` returns `SiteTariffsTimelineResponse` v2.
- `POST /api/site/[id]/tariffs` returns `400` on invalid schedules/rates and `201` on valid 5-decimal payload, enqueuing re-attribution + scheduling `after()`.
- `PATCH` / `DELETE` enforce `'manual'` rules (`DELETE` on `'tesla'` -> `400`; non-existent `periodId` -> `404`).
- `readMobileBillRevision` produces a new ETag/revision whenever `tariffReattribution` status/progress changes (`pending` -> `running` -> `idle`) even when `[cycleStart, cycleEnd]` history is unchanged.
- `GET /api/cron/reattribute-tariffs` rejects bad `CRON_SECRET` (`401`), invokes `runPendingReattributionsCron` under `withIoDeadline(50_000)`, emits `cron.reattribute-tariffs.*`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/app/api/site/\[id\]/tariffs/route.test.ts src/app/api/cron/reattribute-tariffs/route.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement all API routes, cron handler, and `bill-summary` integration**

Example route skeleton for `cmd/next-app/src/app/api/site/[id]/tariffs/route.ts`:
```ts
import { after, NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import { enqueueTariffReattribution, REATTRIBUTION_AFTER_MAX_TIME_MS, runSiteReattribution } from '@/lib/tariff-reattribution';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffTimelineRepo } from '@/lib/tariff-timeline-repo';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    return json(await new TariffTimelineRepo().getTimeline(siteId, user.id));
  })(_req);
}

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs', async () => {
    if (isCrossOriginRequest(req)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    try {
      const body = await req.json();
      const repo = new TariffTimelineRepo();
      const timeline = await repo.createManualPeriod(siteId, user.id, body);
      const reattribution = await enqueueTariffReattribution({
        siteId, fromDate: body.effectiveFrom, toDate: body.effectiveTo,
        requestedByUserId: user.id, trigger: 'create',
      });
      after(() => withIoDeadline(10_000, () =>
        runSiteReattribution({ siteId, trigger: 'after', maxTimeMs: REATTRIBUTION_AFTER_MAX_TIME_MS })
      ));
      return json({ ...timeline, reattribution }, 201);
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      return json({ error: 'Could not save rate plan.', ...errorFields(error) }, 500);
    }
  })(req);
}
```
Follow the exact same pattern (including `isCrossOriginRequest(req)` on every mutating handler) for `[periodId]/route.ts` (`PATCH` / `DELETE`), `tariffs/reattribute/route.ts` (`POST`), `/api/cron/reattribute-tariffs/route.ts` (`maxDuration = 60`, `HARD_DEADLINE_MS = 50_000`, Bearer `CRON_SECRET`, `flushLogEvents()`), `refresh-tariffs/route.ts` (`POST` only), `mobile-bill-revision.ts` (`tariffReattribution` included in revision digest), and `mobile/bill-summary/route.ts` (`tariffReattribution`).

- [ ] **Step 4: Run tests**

Run: `npm test -- --run src/app/api/site/\[id\]/tariffs/route.test.ts src/app/api/site/\[id\]/refresh-tariffs/route.test.ts src/app/api/cron/reattribute-tariffs/route.test.ts src/lib/mobile-bill-revision.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/site/[id]/tariffs src/app/api/site/[id]/refresh-tariffs src/app/api/cron/reattribute-tariffs src/app/api/mobile/bill-summary/route.ts src/lib/mobile-bill-revision.ts src/lib/mobile-bill-revision.test.ts src/lib/mobile-dashboard-contract.ts
git commit -m "feat(api): add tariff timeline CRUD routes, reattribution cron, and v2 cutover"
```

---

## Task 6: Web Read-Only Timeline & Site Settings Update (`cmd/next-app`)

**Files:**
- Modify: `cmd/next-app/src/components/site/TariffList.tsx`
- Modify: `cmd/next-app/src/components/site/SettingsView.tsx`
- Modify: site settings server page fetching initial props for `SettingsView` (grep for `<SettingsView` inside `cmd/next-app/src/app` to locate exact file before editing!)
- Test: `cmd/next-app/src/components/site/TariffList.test.tsx` & verify `SettingsView.test.tsx`

**Interfaces:**
- Consumes: `SiteTariffsTimelineResponse` passed into `SettingsView` -> `TariffList`, plus `POST /api/site/[id]/tariffs/reattribute` retry button and `POST /api/site/[id]/refresh-tariffs`.

- [ ] **Step 1: Write failing component test `TariffList.test.tsx`**

Verify rendering of:
1. Active & historical effective-date spans with `"Active today"` / `"Custom"` / `"Synced from Tesla"` badges and `updatedBy` label separated with middle dots (`·`).
2. Explicit timeline gap fallback rows whenever consecutive spans have uncovered calendar days between `effectiveTo + 1 day` and the next `effectiveFrom` (`"<gapStart> – <gapEnd> · Uses nearest prior plan"`).
3. Up to **5-decimal** rate formatting (`$0.30335`, `$0.10` — no truncation to 4 decimals).
4. Re-attribution progress banner (`pending` / `running` / `failed` with **Retry** button) and Tesla divergence notice.
5. Helper note stating rate plan editing is available in the PWUsage iOS app; replace all legacy `"tariff"` and `"TOU"` labels/prose in `TariffList.tsx` (`"Rate Plan"`, `"Rate Period"`) so zero forbidden terms leak.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/components/site/TariffList.test.tsx`
Expected: FAIL

- [ ] **Step 3: Update `TariffList.tsx`, `SettingsView.tsx`, and settings server page loader**

Format prices dynamically with minimum 2, maximum 5 fraction digits (`Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 5 })`), render explicit gap fallback rows between non-adjacent spans, use `·` metadata separators, and scrub all legacy `"TOU"`/`"tariff"` strings from `TariffList.tsx`.

- [ ] **Step 4: Run all Next.js checks (`lint`, `typecheck`, `test`, `build`)**

Run from `cmd/next-app`:
```bash
npm run lint
npm run typecheck
npm test -- --run
npm run build
```
Expected: All PASS with zero errors/warnings.

- [ ] **Step 5: Commit**

```bash
git add src/components/site/ src/app/
git commit -m "feat(web): render read-only effective tariff timeline with 5-decimal precision"
```

---

## Task 7: iOS v2 Timeline Contracts, `RateFormatting`, API Client & Coordinator (`cmd/ios-app`)

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` (replace v1 `MobileTariffsResponse` cleanly with `SiteTariffsTimelineResponse`, `TariffPeriodDTO`, `TariffSeasonInput`, `TimePeriodWindowInput`, `ReattributionStatusDTO`, `TariffUpdatedByDTO`, `TariffPlanWriteRequest`, `MobileTariffDataAPI`)
- Modify: `cmd/ios-app/Shared/MobileLiveContract.swift` (mirror optional `tariffReattribution: ReattributionStatusDTO?` on `MobileBillResponse` — keep matching server `mobile-dashboard-contract.ts` per root `AGENTS.md`)
- Create: `cmd/ios-app/PWUsage/Models/Bill/RateFormatting.swift` (`formatRate(_:currency:)` displaying 2..5 decimals + decimal input parsing/validation)
- Modify: `cmd/ios-app/PWUsage/Networking/PWUsageAPI.swift:115-160` (`fetchTariffTimeline`, `refreshTariffsFromTesla`, `createTariffPeriod`, `updateTariffPeriod`, `deleteTariffPeriod`, `retryTariffReattribution`)
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator.swift:296-316`
- Modify: `cmd/ios-app/PWUsage/Demo/DemoAPI.swift` & `cmd/ios-app/PWUsage/Demo/DemoFixtures.swift` (return realistic multi-period effective-dated fixture; demo edits mutate in-memory state cleanly or throw clear demo message)
- Update tests: `cmd/ios-app/PWUsageTests/PWUsageAPITransportTests.swift`, `MobileContractsBillTests.swift`, `DemoAPITests.swift`, `TariffSheetTests.swift`, plus new `RateFormattingTests.swift`

**Interfaces:**
- Produces `MobileTariffDataAPI` (`Sendable`):
  - `func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse`
  - `func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse`
  - `func createTariffPeriod(siteID: String, body: TariffPlanWriteRequest) async throws -> SiteTariffsTimelineResponse`
  - `func updateTariffPeriod(siteID: String, periodID: Int, body: TariffPlanPatchRequest) async throws -> SiteTariffsTimelineResponse`
  - `func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse`
  - `func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse`
- Produces `RateFormatting.formatRate(_ value: Double, currency: String) -> String` & `RateFormatting.parseRate(_ text: String) -> Result<Double, RateInputError>`

- [ ] **Step 1: Write failing Swift Testing unit tests in `RateFormattingTests.swift` & update contract tests**

Create `cmd/ios-app/PWUsageTests/RateFormattingTests.swift`:
```swift
import Testing
@testable import PWUsage

struct RateFormattingTests {
    @Test func formatsTwoToFiveDecimalsWithoutTruncatingPrecision() {
        #expect(RateFormatting.formatRate(0.1, currency: "USD") == "$0.10")
        #expect(RateFormatting.formatRate(0.30335, currency: "USD") == "$0.30335")
        #expect(RateFormatting.formatRate(0.0005, currency: "USD") == "$0.0005")
    }

    @Test func rejectsMoreThanFiveDecimalsAndNegativeValues() {
        #expect(RateFormatting.parseRate("0.30335") == .success(0.30335))
        #expect(RateFormatting.parseRate("0.123456") == .failure(.tooManyDecimalPlaces))
        #expect(RateFormatting.parseRate("-0.01") == .failure(.negativeOrInvalid))
    }
}
```
Update `PWUsageAPITransportTests.swift`, `MobileContractsBillTests.swift`, `DemoAPITests.swift`, and `TariffSheetTests.swift` to test v2 `SiteTariffsTimelineResponse` JSON decoding (`updatedBy`, `reattribution`, `teslaSync`).

- [ ] **Step 2: Run `./cmd/ios-app/run-tests.sh --quick` to verify failure**

Expected: FAIL on missing new symbols/models.

- [ ] **Step 3: Implement v2 contract models, `RateFormatting`, `PWUsageAPI`, `DashboardCoordinator`, and `DemoAPI`/`DemoFixtures`**

Create `cmd/ios-app/PWUsage/Models/Bill/RateFormatting.swift`:
```swift
import Foundation

enum RateInputError: Error, Equatable {
    case empty
    case negativeOrInvalid
    case tooManyDecimalPlaces
    case exceedsMaximum
}

enum RateFormatting {
    static func formatRate(_ value: Double, currency: String) -> String {
        guard value.isFinite else { return "—" }
        return value.formatted(
            .currency(code: currency)
                .precision(.fractionLength(2...5))
        )
    }

    static func parseRate(_ rawText: String) -> Result<Double, RateInputError> {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.empty) }
        guard !trimmed.hasPrefix("-"), let value = Double(trimmed), value.isFinite, value >= 0 else {
            return .failure(.negativeOrInvalid)
        }
        if let dot = trimmed.firstIndex(of: ".") {
            let fractionCount = trimmed.distance(from: trimmed.index(after: dot), to: trimmed.endIndex)
            if fractionCount > 5 { return .failure(.tooManyDecimalPlaces) }
        }
        if value > 10.0 { return .failure(.exceedsMaximum) }
        return .success((value * 100_000).rounded() / 100_000)
    }
}
```
Replace `cmd/ios-app/PWUsage/Models/Bill/MobileTariffs.swift` with `SiteTariffsTimelineResponse`, `TariffPeriodDTO`, `TariffSeasonInput`, `TimePeriodWindowInput`, `TariffPeriodName`, `TariffUpdatedByDTO` (`email: String?`, `isCurrentUser: Bool` — omitting internal `userId`), `TariffPlanWriteRequest`, `TariffPlanPatchRequest`, and `MobileTariffDataAPI`, and place shared `ReattributionStatusDTO` in `cmd/ios-app/Shared/MobileLiveContract.swift` so both `MobileBillResponse` and `SiteTariffsTimelineResponse` share the exact same `Sendable, Codable, Equatable` definition. Keep all lines `<= 120` chars, functions `<= 50` lines, and zero `!` force unwraps.

- [ ] **Step 4: Run `./cmd/ios-app/lint.sh` and `./cmd/ios-app/run-tests.sh --quick`**

Expected: PASS with zero SwiftLint warnings/errors.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/
git commit -m "feat(ios): migrate tariff contracts to v2 timeline APIs and add 5-decimal formatting"
```

---

## Task 8: iOS `RatePlanDraft` Validation State & Rate Plans Timeline (`TariffSheet`) (`cmd/ios-app`)

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Bill/RatePlanDraft.swift` (`RatePlanDraft`, `SeasonDraft`, `DayPeriodDraft`, `RatePlanEditorState`, pure validation + season/window boundary adjustment helpers)
- Modify: `cmd/ios-app/PWUsage/Views/Bill/TariffSheet.swift` (and decompose row/banner components cleanly into `cmd/ios-app/PWUsage/Views/Bill/TariffPeriodCardView.swift`, `ReattributionBannerView.swift`, `EffectiveDatesSheet.swift`)
- Modify: `cmd/ios-app/PWUsage/Views/Settings/SettingsView.swift:102-105` (wire coordinator action closures into `TariffSheet`)
- Test: `cmd/ios-app/PWUsageTests/RatePlanDraftTests.swift` & update `TariffSheetTests.swift`

**Interfaces:**
- Consumes: Task 7 DTOs & `MobileTariffDataAPI`, `RateFormatting`, `DashboardCoordinator`
- Produces:
  - `RatePlanDraft`: `init(from period: TariffPeriodDTO)` (copying exact `period.name` without appending year/copy suffixes), `init(blankIn siteTimezone: TimeZone)` (empty name with `"Utility Rate Plan"` placeholder), `toWriteRequest()`, `validate()`, `addSeason()`, `removeSeason(at:)`, `moveSeasonBoundary(...)`, `addTimePeriod(inSeason:isWeekday:)`, `removeTimePeriod(...)`, `movePeriodBoundary(...)`
  - `TariffSheet`: interactive Rate Plans timeline showing re-attribution polling banner (`Task.sleep(for: .seconds(3))` while `pending`/`running` **and paused while `isPresentingEditor` is true**), Tesla divergence card, explicit timeline gap fallback rows (`"<gapStart> – <gapEnd> · Uses nearest prior plan"`), period cards with static `"Active today"` / `"Active now"` schedule display (**removing the existing 1-second `TimelineView` ticking loop**), horizontal weekday/weekend bars, `updatedBy` shared-site attribution, and context actions (`Edit Plan`, `Copy & Customize`, `Edit Dates`, `Delete`) launching Task 9's editor sheet.

- [ ] **Step 1: Write failing `RatePlanDraftTests.swift` unit tests**

Create `cmd/ios-app/PWUsageTests/RatePlanDraftTests.swift`:
```swift
import Foundation
import Testing
@testable import PWUsage

struct RatePlanDraftTests {
    @Test func addingAndMovingSeasonsKeepsTwelveMonthsCoveredWithoutGaps() {
        var draft = RatePlanDraft.makeBlank(timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt)
        #expect(draft.validate() == nil)
        draft.addSeason()
        #expect(draft.seasons.count == 2)
        draft.seasons[0].fromMonth = 10
        draft.seasons[0].toMonth = 5
        draft.seasons[1].fromMonth = 6
        draft.seasons[1].toMonth = 9
        #expect(draft.validate() == nil)
    }

    @Test func scheduleHandlesMidnightWraparoundAndMinimumThirtyMinuteWindow() {
        var season = SeasonDraft.makeDefault(name: "Summer", fromMonth: 6, toMonth: 9)
        season.weekdayWindows = [
            DayPeriodDraft(touName: .offPeak, startSlot: 40, endSlot: 16, buyRateText: "0.10279", sellRateText: "0.0329"),
            DayPeriodDraft(touName: .onPeak, startSlot: 16, endSlot: 40, buyRateText: "0.30335", sellRateText: "0.04906"),
        ]
        #expect(season.validateWeekdaySlots() == nil)
        let request = season.toInput()
        #expect(request?.weekdayPeriods.first?.buyRate == 0.10279)
    }
}
```

- [ ] **Step 2: Run `./cmd/ios-app/run-tests.sh --quick` to verify failure**

Expected: FAIL

- [ ] **Step 3: Implement `RatePlanDraft.swift`, timeline subviews, upgraded `TariffSheet.swift`, and `SettingsView.swift` hookup**

Note `docs/voice-and-terms.md`: zero occurrences of `"tariff"` or `"TOU"` in UI strings; use `"Rate Plans"`, `"Custom"`, `"Tesla"`, `"Edited by you"` / `"Edited by <email>"`, `"Updating historical rates · X of Y days"`. Remove the legacy 1-second `TimelineView` from `TariffSheet.swift`, pause re-attribution polling whenever `isPresentingEditor == true`, render explicit fallback rows for any gap between adjacent spans, and model slot arrays using integer 30-minute ticks `0..<48` (`startSlot` in `0...47`, `endSlot` in `0...48`, where `endSlot <= startSlot` represents midnight wraparound) so both validation and the interactive slider share identical math.

- [ ] **Step 4: Run `./cmd/ios-app/lint.sh` and `./cmd/ios-app/run-tests.sh --quick`**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/
git commit -m "feat(ios): add RatePlanDraft state engine and interactive Rate Plans timeline"
```

---

## Task 9: iOS Tesla-Style Editor Screens (Summary, Seasons Slider, 24h Schedule Slider, Pricing) (`cmd/ios-app`)

**Files:**
- Create: `cmd/ios-app/PWUsage/Views/Bill/RatePlanEditorFlow.swift` (NavigationStack coordinator + Summary screen with exact plan name pre-fill on `"Copy & Customize"`/`"Edit"`, empty `"Utility Rate Plan"` placeholder on new blank plan, expandable Season disclosure rows, Effective Dates row & preview impact text, `"Save Rate Plan"`)
- Create: `cmd/ios-app/PWUsage/Views/Bill/RatePlanSeasonsEditorView.swift` (12-month vertical block slider, `Add Season`/`Remove Season`, haptic snap handles, wraparound support + VoiceOver +/- steppers)
- Create: `cmd/ios-app/PWUsage/Views/Bill/RateScheduleEditorView.swift` (`Weekdays (Mon – Fri)` / `Weekends (Sat – Sun)` toggle, `"Same schedule as weekdays"` toggle, left period list with `+ Add Time Period` / type picker / delete + right 24h vertical color track slider with 30-min snapping pill handles + accessible +/- 30m buttons)
- Create: `cmd/ios-app/PWUsage/Views/Bill/RatePricingEditorView.swift` (top Weekday/Weekend horizontal bars, per-period Buy/Sell numeric cards supporting 0–5 decimals with `.decimalPad`, inline validation, and concise export netting helper caption explaining how Sell rates feed savings/export-cushion estimates)
- Modify: `cmd/ios-app/PWUsage/Views/Bill/TariffSheet.swift` (present `RatePlanEditorFlow` on `+ Add Rate Plan`, `Edit`, and `Customize Rates`)
- Test: `cmd/ios-app/PWUsageTests/RatePlanEditorFlowTests.swift` (view-model/interaction logic tests for stepping, direct Summary->Edit->Summary jumps, error mapping on save failure, demo save behavior)

**Interfaces:**
- Consumes: `RatePlanDraft`, `RateFormatting`, `SiteTariffsTimelineResponse`, `Color.emphasis` (`Shared/Color+Emphasis.swift`)
- Produces: Complete modal flow returning saved `SiteTariffsTimelineResponse` to `TariffSheet`.

- [ ] **Step 1: Write failing `RatePlanEditorFlowTests.swift`**

Test wizard flow state transitions (new plan wizard order `Seasons -> Schedule -> Pricing -> Summary` vs editing existing plan directly from Summary), `"Same schedule as weekdays"` toggle copy/unlink behavior, and handling server validation `400` / network errors without discarding user edits.

- [ ] **Step 2: Run `./cmd/ios-app/run-tests.sh --quick` to verify failure**

Expected: FAIL

- [ ] **Step 3: Implement the 4 Tesla-style SwiftUI editor screens & wire into `TariffSheet`**

Decompose slider subviews into focused helper views (`SeasonMonthBlock`, `TimelineTrackSlider`, `RateInputCard`) so every view body stays well below SwiftLint's 50-line budget and compiles cleanly under `-O`.

- [ ] **Step 4: Full cross-app verification before completion**

Run in `cmd/ios-app`:
```bash
./cmd/ios-app/lint.sh
./cmd/ios-app/run-tests.sh
```
Run in `cmd/next-app`:
```bash
npm run lint
npm run typecheck
npm test -- --run
npm run build
```
Expected: All checks, linters, builds, and unit/Postgres suites PASS cleanly.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/
git commit -m "feat(ios): add Tesla-style rate plan summary, seasons, schedule, and 5-decimal pricing editors"
```
