import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { safeActivityTestSocket } from './battery-hold-activity-test-db';
import { createTariffTestDatabase } from './tariff-test-db';

const local = vi.hoisted(() => ({ database: undefined as unknown as Pool }));
vi.mock('./db', () => ({
  pool: {
    query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
    connect: () => local.database.connect(),
  },
}));
vi.mock('./energy-repo-factory', () => ({
  createEnergyRepo: () => ({ getCycleAggregates: async () => [] }),
}));

import type { TariffSeasonInput, TimePeriodWindowInput } from './tariff-contract';
import { TariffRepo } from './tariff-repo';
import { commitTariffSelection, previewTariffSelection } from './tariff-selection-service';
import { compileSeasonsToParsedTariff } from './tariff-timeline';
import { TariffTimelineRepo } from './tariff-timeline-repo';
import { TeslaTariffSyncRepo } from './tesla-tariff-sync-repo';

const TZ = 'America/Chicago';
const TODAY = '2026-11-16';
const SITE = 'sync-pg-1';

function win(
  touName: TimePeriodWindowInput['touName'],
  fromHour: number,
  toHour: number,
  buyRate: number,
  sellRate: number,
): TimePeriodWindowInput {
  return { touName, fromHour, fromMinute: 0, toHour, toMinute: 0, buyRate, sellRate };
}

/** The Tesla-side plan the site had before the owner picked a custom plan. */
const TESLA_SEASONS: TariffSeasonInput[] = [{
  name: 'All Year',
  fromMonth: 1,
  toMonth: 12,
  weekdayPeriods: [win('OFF_PEAK', 0, 24, 0.12, 0.03)],
  weekendPeriods: [win('OFF_PEAK', 0, 24, 0.12, 0.03)],
}];

/** The custom plan the owner picks over Tesla's; the Tesla import below carries these rates. */
const CUSTOM_SEASONS: TariffSeasonInput[] = [
  {
    name: 'Summer',
    fromMonth: 6,
    toMonth: 9,
    weekdayPeriods: [
      win('OFF_PEAK', 0, 16, 0.1, 0.03),
      win('ON_PEAK', 16, 21, 0.4, 0.05),
      win('OFF_PEAK', 21, 24, 0.1, 0.03),
    ],
    weekendPeriods: [win('OFF_PEAK', 0, 24, 0.1, 0.03)],
  },
  {
    name: 'Winter',
    fromMonth: 10,
    toMonth: 5,
    weekdayPeriods: [win('OFF_PEAK', 0, 24, 0.12, 0.03)],
    weekendPeriods: [win('OFF_PEAK', 0, 24, 0.12, 0.03)],
  },
];

describe.skipIf(!safeActivityTestSocket)('Sync to Tesla keeps the active plan and the Tesla original (postgres)', () => {
  const repo = new TariffTimelineRepo();
  const tariffRepo = new TariffRepo();

  beforeAll(async () => {
    local.database = await createTariffTestDatabase('tesla_tariff_sync_service_test');
    await local.database.query(
      'ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS utility TEXT, ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ'
    );
    await local.database.query(
      `INSERT INTO "Site"(id, user_id, timezone, json) VALUES ($1, 'u1', $2, '{"currency":"USD"}')`,
      [SITE, TZ]
    );
  });

  afterAll(async () => {
    if (local.database) await local.database.end();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function snapshotPeriods() {
    const periods = await local.database.query<{ tariff_id: number; source: string; effective_from: string; effective_to: string | null }>(
      `SELECT tariff_id, source, effective_from::text, effective_to::text
         FROM "TariffEffectivePeriod" WHERE site_id = $1 ORDER BY id`,
      [SITE]
    );
    const originals = await local.database.query<{ selection_id: number; original_tariff_id: number; effective_from: string }>(
      `SELECT selection_id, original_tariff_id, effective_from::text
         FROM "TariffSelectionOriginal" WHERE site_id = $1 ORDER BY id`,
      [SITE]
    );
    return { periods: periods.rows, originals: originals.rows };
  }

  it('importing our own upload as the Tesla plan leaves effective periods and the saved original alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T18:00:00Z`) });

    // The Tesla plan the site had, dated from January.
    const teslaPlan = compileSeasonsToParsedTariff('Tesla Original', TESLA_SEASONS);
    await tariffRepo.addTariffVersion(SITE, teslaPlan);
    const teslaRow = await local.database.query<{ id: number }>(
      `SELECT id FROM "Tariff" WHERE site_id = $1 AND name = 'Tesla Original' ORDER BY id DESC LIMIT 1`, [SITE]
    );
    await local.database.query(
      `UPDATE "TariffEffectivePeriod" SET effective_from = '2026-01-01', effective_to = NULL
        WHERE site_id = $1 AND tariff_id = $2`,
      [SITE, teslaRow.rows[0].id]
    );

    // The owner picks a custom plan from November. That replaces the Tesla plan and saves it as the original.
    const deps = { now: () => new Date(`${TODAY}T18:00:00Z`), repo };
    const request = {
      scope: 'actual' as const,
      candidate: { kind: 'manual' as const, name: 'Custom Plan', seasons: CUSTOM_SEASONS },
      effectiveFrom: '2026-11-01',
      effectiveTo: null,
    };
    const preview = await previewTariffSelection(SITE, 'u1', request, deps);
    await commitTariffSelection(SITE, 'u1', { ...request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false }, deps);

    const before = await snapshotPeriods();
    expect(before.originals.length).toBeGreaterThan(0);
    const activeBefore = await repo.loadActiveActualPlan(SITE, TODAY);
    expect(activeBefore).toMatchObject({ name: 'Custom Plan', source: 'manual' });

    // Sync to Tesla writes the custom plan; Tesla's import of it comes back through the normal path.
    const uploaded = compileSeasonsToParsedTariff('Utility Tariff', CUSTOM_SEASONS);
    expect(await tariffRepo.addTariffVersion(SITE, uploaded, { name: 'Utility Tariff', code: null })).toBe(true);

    expect(await snapshotPeriods()).toEqual(before);
    expect(await repo.loadActiveActualPlan(SITE, TODAY)).toEqual(activeBefore);
  });

  it('settleUnconfirmed confirms an unconfirmed attempt once the stored plans match', async () => {
    const syncRepo = new TeslaTariffSyncRepo(local.database);
    const client = await local.database.connect();
    let attemptId: number;
    try {
      await client.query('BEGIN');
      const begun = await syncRepo.beginAttempt(client, {
        siteId: SITE,
        userId: 'u1',
        fingerprint: 'fp-settle',
        selectionId: null,
        replacedTeslaTariffId: null,
        sentContent: { name: 'Custom Plan' },
      });
      await client.query('COMMIT');
      if (!('id' in begun)) throw new Error('expected a new attempt');
      attemptId = begun.id;
    } finally {
      client.release();
    }
    await syncRepo.finishAttempt(attemptId, 'unconfirmed', { read: 'old plan' });
    expect((await syncRepo.latestForSite(SITE))?.status).toBe('unconfirmed');

    await syncRepo.settleUnconfirmed(SITE, false);
    expect((await syncRepo.latestForSite(SITE))?.status).toBe('unconfirmed');

    await syncRepo.settleUnconfirmed(SITE, true);
    expect((await syncRepo.latestForSite(SITE))?.status).toBe('confirmed');
  });
});
