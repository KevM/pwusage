import { effectiveTariffIdSql } from './effective-tariff-sql';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { safeActivityTestSocket } from './battery-hold-activity-test-db';
import { createTariffTestDatabase } from './tariff-test-db';

const local = vi.hoisted(() => ({ database: undefined as unknown as Pool }));
vi.mock('./db', () => ({
  pool: {
    query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
    connect: () => local.database.connect(),
  },
}));

import { buildDefaultTariff, parseTariffContent } from './importer/tariff-parser';
import { STORED_TARIFF_CANDIDATES_SQL } from './importer/stored-tariff-backfill';
import { TariffRepo } from './tariff-repo';
import {
  recomputeIsCurrentTariff,
  setFollowedReferenceLabelOnClient,
  TariffSelectionConflictError,
  TariffTimelineRepo,
  UtilityChangedError,
  type FixedComparisonWrite,
} from './tariff-timeline-repo';
import {
  commitTariffSelection,
  listPublicUtilityPlansForSite,
  previewTariffSelection,
} from './tariff-selection-service';
import type { TariffSeasonInput } from './tariff-contract';
import type { ExpandedRevision } from './urdb/history-expand';
import type { TariffPlanWriteInput } from './tariff-timeline';
import { PublicPlansIneligibleError } from './rate-plan-eligibility';
import { siteLocalDateString, addCalendarDays, TariffValidationError } from './tariff-timeline';
import { runUrdbEstimatesCron, runUrdbEstimatesForSite } from './urdb/estimate-job';
import type { UrdbApi } from './urdb/estimate-job';
import type { UrdbRate } from './urdb/types';

vi.mock('./energy-repo-factory', () => ({
  createEnergyRepo: () => ({ getCycleAggregates: async () => [] }),
}));

describe.skipIf(!safeActivityTestSocket)('TariffTimelineRepo & Tesla sync precedence (postgres)', () => {
  afterAll(async () => {
    if (local.database) await local.database.end();
  });

  it('splits existing tesla span, protects active manual plan from tesla overwrite, and preserves immutable rows on delete', async () => {
    local.database = await createTariffTestDatabase('tariff_timeline_repo_test');

    const tariffRepo = new TariffRepo();
    await tariffRepo.addTariffVersion('s1', {
      name: 'Utility Rounded',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.1, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.1, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });

    const repo = new TariffTimelineRepo();
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

    const manualPeriodId = active!.periodId;
    await repo.deleteManualPeriod('s1', manualPeriodId, 'u1');
    const afterDelete = await repo.getTimeline('s1', 'u1');
    expect(afterDelete.periods.find(p => p.isCurrentToday)?.source).toBe('tesla');
    const manualTariffStillExists = await local.database.query(`SELECT id FROM "Tariff" WHERE site_id = 's1' AND name = 'Exact 2026'`);
    expect(manualTariffStillExists.rowCount).toBe(1);
  });
  it('replays the selection provenance and site rate country migrations without changing data', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s-replay', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const repo = new TariffTimelineRepo();
    await repo.createManualPeriod('s-replay', 'u1', {
      name: 'Replay Plan',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      seasons: [{
        name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
      }],
    });
    const before = await repo.getTimeline('s-replay', 'u1');
    const migrations = (await readdir('db-migrations'))
      .filter(f => f.endsWith('_tariff_selection_provenance.sql') || f.endsWith('_site_rate_country.sql'))
      .sort();
    expect(migrations).toHaveLength(2);
    for (const file of migrations) {
      await local.database.query(await readFile(`db-migrations/${file}`, 'utf8'));
    }
    const after = await repo.getTimeline('s-replay', 'u1');
    expect(after.periods).toEqual(before.periods);
    expect(after.rateCountry).toEqual(before.rateCountry);
  });
  it('marks the nearest earlier plan as active when today falls in a gap, like billing does', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s-gap', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const repo = new TariffTimelineRepo();
    const input = (name: string) => ({
      name,
      effectiveFrom: '2024-01-01',
      effectiveTo: '2024-12-31',
      seasons: [{
        name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
      }],
    });
    await repo.createManualPeriod('s-gap', 'u1', input('Ended long ago'));
    const timeline = await repo.getTimeline('s-gap', 'u1');
    expect(timeline.periods.filter(p => p.isCurrentToday).map(p => p.name)).toEqual(['Ended long ago']);
  });

  it('resolves many dates with one period read and one batched hydrate, matching the single-date resolver', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s-batch', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const repo = new TariffTimelineRepo();
    const flat = (buyRate: number) => [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate, sellRate: 0.03 }];
    const plan = (name: string, effectiveFrom: string, effectiveTo: string | null, rate: number) => ({
      name, effectiveFrom, effectiveTo,
      seasons: [{ name: 'All Year', fromMonth: 1, toMonth: 12, weekdayPeriods: flat(rate), weekendPeriods: flat(rate) }],
    });
    await repo.createManualPeriod('s-batch', 'u1', plan('Plan 2024', '2024-01-01', '2024-12-31', 0.1));
    await repo.createManualPeriod('s-batch', 'u1', plan('Plan 2026', '2026-01-01', null, 0.2));
    const dates = ['2023-06-01', '2024-06-01', '2025-06-01', '2026-06-01'];

    const client = await local.database.connect();
    try {
      const queries: string[] = [];
      const counting = { query: (...args: Parameters<typeof client.query>) => {
        queries.push(String(args[0]));
        return Reflect.apply(client.query, client, args);
      } } as unknown as typeof client;
      const batch = await repo.resolveTariffsForDates(counting, 's-batch', dates);
      // One period read, then the tariff, season and schedule reads: not four lookups per date.
      expect(queries).toHaveLength(4);
      const names = dates.map(date => batch.get(date)?.[0]?.name);
      expect(names).toEqual(['Plan 2024', 'Plan 2024', 'Plan 2024', 'Plan 2026']);
      for (const date of dates) {
        const single = await repo.resolveTariffForDate(client, 's-batch', date);
        expect(single.tariffs[0]?.id).toBe(batch.get(date)?.[0]?.id);
        expect(single.schedules.length).toBeGreaterThan(0);
      }
    } finally {
      client.release();
    }
  });

  it('falls back to the current tariff for every date when a site has no effective periods', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s-noperiod', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    await new TariffRepo().addTariffVersion('s-noperiod', {
      name: 'Only Current',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.1, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.1, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });
    await local.database.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = 's-noperiod'`);
    const client = await local.database.connect();
    try {
      const batch = await new TariffTimelineRepo().resolveTariffsForDates(client, 's-noperiod', ['2025-01-01', '2026-01-01']);
      expect([...batch.values()].map(t => t[0]?.name)).toEqual(['Only Current', 'Only Current']);
    } finally {
      client.release();
    }
  });

  it('resolves the tariff in effect today from dates, even when is_current is stale', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s-roll', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const repo = new TariffTimelineRepo();
    const period = [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }];
    await repo.createManualPeriod('s-roll', 'u1', {
      name: 'Covers today', effectiveFrom: '2020-01-01', effectiveTo: null,
      seasons: [{ name: 'All Year', fromMonth: 1, toMonth: 12, weekdayPeriods: period, weekendPeriods: period }],
    });
    // A date rollover changes the plan in effect without any mutation, leaving the flag behind.
    await local.database.query(`UPDATE "Tariff" SET is_current = FALSE WHERE site_id = 's-roll'`);
    const covering = await local.database.query(`SELECT tariff_id FROM "TariffEffectivePeriod" WHERE site_id = 's-roll'`);
    const resolved = await local.database.query(
      `SELECT ${effectiveTariffIdSql('s.id')} AS id FROM "Site" s WHERE s.id = 's-roll'`
    );
    expect(Number(resolved.rows[0].id)).toBe(Number(covering.rows[0].tariff_id));
  });

  it('bounds Tesla healing to the dates a moved manual period actually vacated', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s2', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const tariffRepo = new TariffRepo();
    await tariffRepo.addTariffVersion('s2', {
      name: 'Utility Heal',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.1, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.1, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });
    const teslaTariffId = (await local.database.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = 's2'`)).rows[0]!.id;
    await local.database.query(
      `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source)
       VALUES ('s2', $1, '2025-12-01', '2025-12-31', 'tesla'), ('s2', $1, '2026-02-01', '2026-03-31', 'tesla')`,
      [teslaTariffId]
    );
    const repo = new TariffTimelineRepo();
    const created = await repo.createManualPeriod('s2', 'u1', {
      name: 'January only',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-01-31',
      seasons: [{
        name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.2, sellRate: 0.05 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.2, sellRate: 0.05 }],
      }],
    });
    const periodId = created.periods.find(p => p.name === 'January only')!.periodId;

    await repo.updatePeriod('s2', periodId, 'u1', { effectiveFrom: '2026-04-01', effectiveTo: '2026-04-30' });

    const { rows } = await local.database.query<{ source: string; effective_from: string; effective_to: string | null }>(
      `SELECT source, effective_from::text, effective_to::text FROM "TariffEffectivePeriod"
       WHERE site_id = 's2' AND effective_to < '2026-06-01' ORDER BY effective_from`
    );
    expect(rows.map(r => [r.source, r.effective_from, r.effective_to])).toEqual([
      ['tesla', '2025-12-01', '2026-03-31'],
      ['manual', '2026-04-01', '2026-04-30'],
    ]);
  });
  it('keeps the requested dates when a Tesla period is edited', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s3', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    await new TariffRepo().addTariffVersion('s3', {
      name: 'Utility Tesla Edit',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.1, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.1, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });
    const repo = new TariffTimelineRepo();
    const tesla = (await repo.getTimeline('s3', 'u1')).periods.find(p => p.source === 'tesla')!;
    const to = '2099-12-31';
    await repo.updatePeriod('s3', tesla.periodId, 'u1', { effectiveTo: to });
    const { rows } = await local.database.query<{ effective_to: string | null }>(
      `SELECT effective_to::text FROM "TariffEffectivePeriod" WHERE site_id = 's3'`
    );
    expect(rows).toEqual([{ effective_to: to }]);
  });
  it('does not mark a plan that has not started as current while today is in a gap', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s4', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const a = (await local.database.query<{ id: number }>(
      `INSERT INTO "Tariff"(site_id, name, version, is_current) VALUES ('s4', 'Plan A', 1, false) RETURNING id`
    )).rows[0]!.id;
    const b = (await local.database.query<{ id: number }>(
      `INSERT INTO "Tariff"(site_id, name, version, is_current) VALUES ('s4', 'Plan B', 2, false) RETURNING id`
    )).rows[0]!.id;
    await local.database.query(
      `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source)
       VALUES ('s4', $1, $3::date, $4::date, 'manual'), ('s4', $2, $5::date, NULL, 'manual')`,
      [a, b, day(-60), day(-2), day(30)]
    );
    const client = await local.database.connect();
    try {
      const chosen = await recomputeIsCurrentTariff(client, 's4', day(0));
      expect(chosen).toBe(a);
    } finally {
      client.release();
    }
  });
  it('requires rate plan names to be unique per site', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s5', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const repo = new TariffTimelineRepo();
    const input = (name: string, from: string, to: string | null) => ({
      name,
      effectiveFrom: from,
      effectiveTo: to,
      seasons: [{
        name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
      }],
    });
    const first = await repo.createManualPeriod('s5', 'u1', input('Home Plan', '2024-01-01', '2024-12-31'));
    await expect(repo.createManualPeriod('s5', 'u1', input('  home plan ', '2025-01-01', null)))
      .rejects.toThrow(/already exists/);

    // Editing a plan's own dates or rates keeps its name without tripping the check.
    const id = first.periods.find(p => p.name === 'Home Plan')!.periodId;
    const { timeline } = await repo.updatePeriod('s5', id, 'u1', { effectiveTo: '2024-11-30' });
    const currentId = timeline.periods.find(p => p.name === 'Home Plan')!.periodId;

    // Renaming onto another plan's name is refused.
    await repo.createManualPeriod('s5', 'u1', input('Other Plan', '2025-01-01', null));
    await expect(repo.updatePeriod('s5', currentId, 'u1', { name: 'OTHER PLAN' })).rejects.toThrow(/already exists/);
  });
  it('clears the current flag when the last effective period is deleted', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s6', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const repo = new TariffTimelineRepo();
    const created = await repo.createManualPeriod('s6', 'u1', {
      name: 'Only Plan', effectiveFrom: '2024-01-01', effectiveTo: null,
      seasons: [{
        name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK' as const, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
      }],
    });
    const before = await local.database.query(`SELECT 1 FROM "Tariff" WHERE site_id = 's6' AND is_current`);
    expect(before.rowCount).toBe(1);
    await repo.deleteManualPeriod('s6', created.periods[0]!.periodId, 'u1');
    const after = await local.database.query(`SELECT 1 FROM "Tariff" WHERE site_id = 's6' AND is_current`);
    expect(after.rowCount).toBe(0);
    // Each mutation queued its re-attribution job in the same transaction.
    const job = await local.database.query(`SELECT generation FROM "SiteTariffReattribution" WHERE site_id = 's6'`);
    expect(Number(job.rows[0]?.generation)).toBe(2);
    const kept = await local.database.query(`SELECT 1 FROM "Tariff" WHERE site_id = 's6'`);
    expect(kept.rowCount).toBe(1);
  });

  it('reference periods never change the actual timeline', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s7', 'u1', 'America/Chicago', '{"currency":"USD"}')`);
    const migRef = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_reference_periods.sql'));
    if (!migRef) throw new Error('Reference migration missing');
    await local.database.query(await readFile(`db-migrations/${migRef}`, 'utf8'));

    const tariffRepo = new TariffRepo();
    await tariffRepo.addTariffVersion('s7', {
      name: 'Tesla ToU',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.25, sell_rate: 0.05,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.25, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });
    const teslaTariffId = (await local.database.query<{ id: number }>(
      `SELECT id FROM "Tariff" WHERE site_id = 's7' AND name = 'Tesla ToU'`
    )).rows[0]?.id;
    if (teslaTariffId === undefined) throw new Error('Tesla tariff missing');

    const refTariffRes = await local.database.query<{ id: number }>(
      `INSERT INTO "Tariff"(site_id, name, version, is_current, source)
       VALUES ('s7', 'Flat Reference', 2, FALSE, 'estimated') RETURNING id`
    );
    const refTariffId = refTariffRes.rows[0].id;

    // Overlapping a Tesla span in TariffEffectivePeriod is accepted in TariffReferencePeriod.
    await local.database.query(
      `INSERT INTO "TariffReferencePeriod"(site_id, tariff_id, effective_from, effective_to, source, updated_by_user_id)
       VALUES ('s7', $1, '2024-01-01', NULL, 'estimated', NULL)`,
      [refTariffId]
    );

    const repo = new TariffTimelineRepo();
    const client = await local.database.connect();
    try {
      const resolved = await repo.resolveTariffForDate(client, 's7', '2026-06-15');
      expect(resolved.tariffs[0]?.id).toBe(teslaTariffId);
    } finally {
      client.release();
    }

    const timeline = await repo.getTimeline('s7', 'u1');
    expect(timeline.referencePeriods).toHaveLength(1);
    expect(timeline.referencePeriods[0]?.name).toBe('Flat Reference');
    expect(timeline.periods.every(p => p.name === 'Tesla ToU')).toBe(true);

    // Creating/updating/deleting a reference period leaves the site's current Tesla plan current.
    const created = await repo.createReferencePeriod('s7', 'u1', {
      name: 'Owner Fixed',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      seasons: [{
        name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.15, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.15, sellRate: 0.03 }],
      }],
    });
    const refId = created.referencePeriods.find(p => p.name === 'Owner Fixed')!.periodId;
    const updatedReference = await repo.updateReferencePeriod('s7', 'u1', refId, { name: 'Owner Fixed v2' });
    const updatedRefId = updatedReference.referencePeriods.find(p => p.name === 'Owner Fixed v2')!.periodId;
    const afterDelete = await repo.deleteReferencePeriod('s7', updatedRefId, 'u1');
    expect(afterDelete.referencePeriods.some(p => p.periodId === updatedRefId)).toBe(false);

    const currentRows = await local.database.query<{ id: number }>(
      `SELECT id FROM "Tariff" WHERE site_id = 's7' AND is_current`
    );
    expect(currentRows.rows.map(r => r.id)).toEqual([teslaTariffId]);
  });

  it('accepts estimated sources, defaults reference sources to manual, and rejects unknown tariff sources', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s-estimated-source', 'u1', 'America/Chicago', '{}')`);
    const referenceMigration = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_reference_periods.sql'));
    if (!referenceMigration) throw new Error('Reference migration missing');
    await local.database.query(await readFile(`db-migrations/${referenceMigration}`, 'utf8'));
    const estimateMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_estimated_rate_plans.sql'));
    if (!estimateMigration) throw new Error('URDB estimate migration missing');
    await local.database.query(await readFile(`db-migrations/${estimateMigration}`, 'utf8'));
    const newerStartMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_newer_plan_start.sql'));
    if (!newerStartMigration) throw new Error('URDB newer plan start migration missing');
    await local.database.query(await readFile(`db-migrations/${newerStartMigration}`, 'utf8'));
    const revisionStartMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_revision_start.sql'));
    if (!revisionStartMigration) throw new Error('URDB revision start migration missing');
    await local.database.query(await readFile(`db-migrations/${revisionStartMigration}`, 'utf8'));
    const ownerHistoryMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_owner_history.sql'));
    if (!ownerHistoryMigration) throw new Error('URDB owner history migration missing');
    await local.database.query(await readFile(`db-migrations/${ownerHistoryMigration}`, 'utf8'));
    const systemCostsMigration = (await readdir('db-migrations')).find(f => f.endsWith('_site_system_costs.sql'));
    if (!systemCostsMigration) throw new Error('Site system costs migration missing');
    await local.database.query(await readFile(`db-migrations/${systemCostsMigration}`, 'utf8'));
    const selectionProvenanceMigration = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_selection_provenance.sql'));
    if (!selectionProvenanceMigration) throw new Error('Tariff selection provenance migration missing');
    await local.database.query(await readFile(`db-migrations/${selectionProvenanceMigration}`, 'utf8'));
    const rateCountryMigration = (await readdir('db-migrations')).find(f => f.endsWith('_site_rate_country.sql'));
    if (!rateCountryMigration) throw new Error('Site rate country migration missing');
    await local.database.query(await readFile(`db-migrations/${rateCountryMigration}`, 'utf8'));
    const tariff = await local.database.query<{ id: number }>(
      `INSERT INTO "Tariff"(site_id, name, version, is_current, source)
       VALUES ('s-estimated-source', 'Estimated', 1, FALSE, 'estimated') RETURNING id`
    );
    await local.database.query(
      `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source)
       VALUES ('s-estimated-source', $1, '2025-01-01', NULL, 'estimated')`,
      [tariff.rows[0]!.id]
    );

    const reference = await local.database.query<{ source: string }>(
      `INSERT INTO "TariffReferencePeriod"(site_id, tariff_id, effective_from, effective_to)
       VALUES ('s-estimated-source', $1, '2025-01-01', NULL) RETURNING source`,
      [tariff.rows[0]!.id]
    );
    expect(reference.rows[0]?.source).toBe('manual');

    await expect(local.database.query(
      `INSERT INTO "Tariff"(site_id, name, version, is_current, source)
       VALUES ('s-estimated-source', 'Unknown', 2, FALSE, 'unknown')`
    )).rejects.toThrow();
  });

  it('splits estimated coverage around an owner period, restores it after deletion, and converts it on edit', async () => {
    await local.database.query(`INSERT INTO "Site" VALUES ('s-estimate-mutation', 'u1', 'America/Chicago', '{}')`);
    const tariffRepo = new TariffRepo();
    await tariffRepo.addTariffVersion('s-estimate-mutation', {
      name: 'Estimated Utility Plan',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31,
        buy_rate: 0.2, sell_rate: 0.05,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.2, sell_rate: 0.05, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });
    const tariffId = (await local.database.query<{ id: number }>(
      `SELECT id FROM "Tariff" WHERE site_id = 's-estimate-mutation' AND name = 'Estimated Utility Plan'`
    )).rows[0]!.id;
    await local.database.query(`UPDATE "Tariff" SET source = 'estimated' WHERE id = $1`, [tariffId]);
    await local.database.query(
      `UPDATE "TariffEffectivePeriod" SET source = 'estimated', effective_from = '2024-01-01', effective_to = NULL WHERE tariff_id = $1`,
      [tariffId]
    );
    await local.database.query(
      `INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source)
       VALUES ($1, 's-estimate-mutation', 'estimated_actual', 'fixture-label', '2024-01-01', 'urdb')`,
      [tariffId]
    );

    const repo = new TariffTimelineRepo();
    const manual = await repo.createManualPeriod('s-estimate-mutation', 'u1', {
      name: 'Owner Plan', effectiveFrom: '2025-01-01', effectiveTo: '2025-01-31',
      seasons: [{
        name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.3, sellRate: 0.06 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.3, sellRate: 0.06 }],
      }],
    });
    const afterCreate = await local.database.query<{ source: string; effective_from: string; effective_to: string | null }>(
      `SELECT source, effective_from::text, effective_to::text FROM "TariffEffectivePeriod"
       WHERE site_id = 's-estimate-mutation' ORDER BY effective_from`
    );
    expect(afterCreate.rows).toEqual([
      { source: 'estimated', effective_from: '2024-01-01', effective_to: '2024-12-31' },
      { source: 'manual', effective_from: '2025-01-01', effective_to: '2025-01-31' },
      { source: 'estimated', effective_from: '2025-02-01', effective_to: null },
    ]);

    const manualId = manual.periods.find(period => period.name === 'Owner Plan')!.periodId;
    await repo.deleteManualPeriod('s-estimate-mutation', manualId, 'u1');
    const afterDelete = await local.database.query<{ source: string; effective_from: string; effective_to: string | null }>(
      `SELECT source, effective_from::text, effective_to::text FROM "TariffEffectivePeriod"
       WHERE site_id = 's-estimate-mutation' ORDER BY effective_from`
    );
    expect(afterDelete.rows).toEqual([
      { source: 'estimated', effective_from: '2024-01-01', effective_to: null },
    ]);

    const estimate = (await repo.getTimeline('s-estimate-mutation', 'u1')).periods[0]!;
    await repo.updatePeriod('s-estimate-mutation', estimate.periodId, 'u1', { name: 'Ownerized Estimate' });
    const afterEdit = await local.database.query<{ source: string; name: string }>(
      `SELECT p.source, t.name FROM "TariffEffectivePeriod" p JOIN "Tariff" t ON t.id = p.tariff_id
       WHERE p.site_id = 's-estimate-mutation'`
    );
    expect(afterEdit.rows).toEqual([{ source: 'manual', name: 'Ownerized Estimate' }]);
  });

  it('parks an unknown site utility without making rate queries', async () => {
    await local.database.query('ALTER TABLE "Site" ADD COLUMN utility TEXT, ADD COLUMN orphaned_at TIMESTAMPTZ');
    await local.database.query(
      `INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source)
       VALUES ('s-unknown-utility', 'u1', 'America/Chicago', '{}', 'Unlisted Local Utility', 'US', 'owner')`
    );
    const api: UrdbApi = {
      utilityNames: async () => ['We Energies'],
      ratesEffectiveOn: async () => { throw new Error('Should not request rates for unknown utility'); },
      rateByLabel: async () => null,
      defaultRates: async () => { throw new Error('Should not request defaults for unknown utility'); },
    };

    const result = await runUrdbEstimatesForSite('s-unknown-utility', api, new Date('2026-11-16T12:00:00Z'));
    const row = await local.database.query<{ status: string; urdb_utility: string | null }>(
      `SELECT status, urdb_utility FROM "SiteUtility" WHERE site_id = 's-unknown-utility'`
    );

    expect(result.status).toBe('needs_utility');
    expect(row.rows[0]).toEqual({ status: 'needs_utility', urdb_utility: null });
  });

  it('leaves a site outside the US ready with no estimates and no OpenEI calls', async () => {
    const siteId = 's-outside-us';
    await local.database.query(
      `INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source)
       VALUES ($1, 'u1', 'Australia/Sydney', '{}', 'AGL', 'AU', 'owner')`,
      [siteId]
    );
    const api: UrdbApi = {
      utilityNames: async () => { throw new Error('Should not list OpenEI utilities for a site outside the US'); },
      ratesEffectiveOn: async () => { throw new Error('Should not request rates for a site outside the US'); },
      rateByLabel: async () => null,
      defaultRates: async () => { throw new Error('Should not request defaults for a site outside the US'); },
    };

    const result = await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T12:00:00Z'));
    const row = await local.database.query<{ status: string; urdb_utility: string | null }>(`SELECT status, urdb_utility FROM "SiteUtility" WHERE site_id = $1`, [siteId]);
    const timeline = await new TariffTimelineRepo().getTimeline(siteId, 'u1');

    expect(result.status).toBe('ready');
    expect(row.rows[0]).toEqual({ status: 'ready', urdb_utility: null });
    expect(timeline.estimates).toMatchObject({ status: 'ready', utilityName: null, historyGuide: null });
  });

  it('moves from needs_plan to an owner-picked current estimate and reuses its tariff rows', async () => {
    const schedule = Array.from({ length: 12 }, () => Array(24).fill(0));
    const defaultRate: UrdbRate = {
      label: 'default-label', name: 'Fixed Residential', utility: 'Wisconsin Electric Power Co',
      startdate: 1_704_067_200, is_default: true,
      energyratestructure: [[{ rate: 0.18 }]], energyweekdayschedule: schedule, energyweekendschedule: schedule,
    };
    const pickedRate: UrdbRate = {
      ...defaultRate, label: 'picked-label', name: 'Picked Residential', is_default: false,
      startdate: 1_735_689_600,
    };
    let selectedRate: UrdbRate | null = null;
    const api: UrdbApi = {
      utilityNames: async () => ['Wisconsin Electric Power Co'],
      ratesEffectiveOn: async () => [],
      rateByLabel: async label => label === 'picked-label' ? selectedRate : null,
      defaultRates: async () => [defaultRate],
    };
    await local.database.query(
      `INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source)
       VALUES ('s-picked-estimate', 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`
    );

    const now = new Date('2026-11-16T12:00:00Z');
    const missingPlan = await runUrdbEstimatesForSite('s-picked-estimate', api, now);
    expect(missingPlan.status).toBe('needs_plan');
    const reference = await local.database.query<{ source: string }>(
      `SELECT source FROM "TariffReferencePeriod" WHERE site_id = 's-picked-estimate'`
    );
    expect(reference.rows).toEqual([{ source: 'estimated' }]);

    selectedRate = pickedRate;
    await local.database.query(
      `UPDATE "SiteUtility" SET choice = 'owner', urdb_plan_label = 'picked-label' WHERE site_id = 's-picked-estimate'`
    );
    const selectedPlan = await runUrdbEstimatesForSite('s-picked-estimate', api, now);
    expect(selectedPlan.status).toBe('ready');
    const actual = await local.database.query<{ source: string; effective_from: string; is_current: boolean; role: string }>(
      `SELECT p.source, p.effective_from::text, t.is_current, u.role
       FROM "TariffEffectivePeriod" p JOIN "Tariff" t ON t.id = p.tariff_id
       JOIN "TariffUrdbSource" u ON u.tariff_id = t.id
       WHERE p.site_id = 's-picked-estimate' AND u.role = 'estimated_actual'`
    );
    expect(actual.rows).toEqual([{ source: 'estimated', effective_from: '2025-01-01', is_current: true, role: 'estimated_actual' }]);

    const beforeRerun = await local.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Tariff" WHERE site_id = 's-picked-estimate'`
    );
    await runUrdbEstimatesForSite('s-picked-estimate', api, now);
    const afterRerun = await local.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Tariff" WHERE site_id = 's-picked-estimate'`
    );
    expect(afterRerun.rows[0]?.count).toBe(beforeRerun.rows[0]?.count);

    await local.database.query(`UPDATE "SiteUtility" SET choice = 'skipped' WHERE site_id = 's-picked-estimate'`);
    await runUrdbEstimatesForSite('s-picked-estimate', api, now);
    const remaining = await local.database.query<{ count: string }>(
      `SELECT (SELECT count(*) FROM "TariffEffectivePeriod" WHERE site_id = 's-picked-estimate' AND source = 'estimated') +
              (SELECT count(*) FROM "TariffReferencePeriod" WHERE site_id = 's-picked-estimate' AND source = 'estimated') AS count`
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);
  });

  it('keeps a manual plan inserted during URDB fetch and clips the estimate around it', async () => {
    await local.database.query(
      `INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source)
       VALUES ('s-owner-edit-during-fetch', 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`
    );
    await local.database.query(
      `INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, urdb_plan_label, status)
       VALUES ('s-owner-edit-during-fetch', 'Wisconsin Electric Power Co', 'owner', 'picked-label', 'pending')`
    );
    const schedule = Array.from({ length: 12 }, () => Array(24).fill(0));
    const picked: UrdbRate = {
      label: 'picked-label', name: 'Picked Residential', utility: 'Wisconsin Electric Power Co',
      startdate: 1_735_689_600, energyratestructure: [[{ rate: 0.18 }]],
      energyweekdayschedule: schedule, energyweekendschedule: schedule,
    };
    let manualWritten = false;
    const api: UrdbApi = {
      utilityNames: async () => ['Wisconsin Electric Power Co'],
      ratesEffectiveOn: async () => [],
      rateByLabel: async label => label === 'picked-label' ? picked : null,
      defaultRates: async () => {
        if (!manualWritten) {
          manualWritten = true;
          await new TariffTimelineRepo().createManualPeriod('s-owner-edit-during-fetch', 'u1', {
            name: 'Edited During URDB', effectiveFrom: '2025-06-01', effectiveTo: null,
            seasons: [{
              name: 'All Year', fromMonth: 1, toMonth: 12,
              weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.3, sellRate: 0.05 }],
              weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.3, sellRate: 0.05 }],
            }],
          });
        }
        return [];
      },
    };

    await runUrdbEstimatesForSite('s-owner-edit-during-fetch', api, new Date('2026-11-16T12:00:00Z'));
    const spans = await local.database.query<{ source: string; effective_from: string; effective_to: string | null }>(
      `SELECT source, effective_from::text, effective_to::text FROM "TariffEffectivePeriod"
       WHERE site_id = 's-owner-edit-during-fetch' ORDER BY effective_from`
    );
    expect(spans.rows).toEqual([
      { source: 'estimated', effective_from: '2025-01-01', effective_to: '2025-05-31' },
      { source: 'manual', effective_from: '2025-06-01', effective_to: null },
    ]);
  });

  const flatTesla = (name: string, buy: number) => ({
    name,
    seasons: [{
      name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: buy, sell_rate: 0.03,
      schedules: [{ name: 'OFF_PEAK', buy_rate: buy, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
    }],
  });
  const flatRate = (label: string, date: string, buy: number, supersedes?: string): UrdbRate => {
    const schedule = Array.from({ length: 12 }, () => Array(24).fill(0));
    return {
      label, name: `Plan ${label}`, utility: 'Wisconsin Electric Power Co', startdate: Date.parse(`${date}T00:00:00Z`) / 1000, supersedes,
      energyratestructure: [[{ rate: buy }]], energyweekdayschedule: schedule, energyweekendschedule: schedule,
    };
  };
  const chainApi = (rates: UrdbRate[]): UrdbApi => ({
    utilityNames: async () => ['Wisconsin Electric Power Co'],
    ratesEffectiveOn: async () => rates.filter(rate => !rates.some(other => other.supersedes === rate.label)),
    rateByLabel: async label => rates.find(rate => rate.label === label) ?? null,
    defaultRates: async () => [],
  });
  const actualSpans = async (siteId: string) => (await local.database.query<{ source: string; effective_from: string; effective_to: string | null; urdb_label: string | null }>(
    `SELECT p.source, p.effective_from::text, p.effective_to::text, u.urdb_label FROM "TariffEffectivePeriod" p
     LEFT JOIN "TariffUrdbSource" u ON u.tariff_id = p.tariff_id AND u.role = 'estimated_actual'
     WHERE p.site_id = $1 ORDER BY p.effective_from`, [siteId]
  )).rows;

  it('matches every Tesla version, even one that no longer owns a span, and walks back from the earliest match', async () => {
    const siteId = 's-unspanned-first-version';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`, [siteId]);
    const tariffRepo = new TariffRepo();
    await tariffRepo.addTariffVersion(siteId, flatTesla('Old Tesla', 0.25));
    await tariffRepo.addTariffVersion(siteId, flatTesla('Current Tesla', 0.18));
    const ids = (await local.database.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = $1 ORDER BY id`, [siteId])).rows.map(row => Number(row.id));
    // Shape left by the historic-effective-tariffs backfill: only the current version owns a span.
    await local.database.query(`UPDATE "Tariff" SET updated = '2024-03-01T12:00:00Z' WHERE id = $1`, [ids[0]]);
    await local.database.query(`UPDATE "Tariff" SET updated = '2025-03-01T12:00:00Z' WHERE id = $1`, [ids[1]]);
    await local.database.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1`, [siteId]);
    await local.database.query(`INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source) VALUES ($1, $2, '2023-01-01', NULL, 'tesla')`, [siteId, ids[1]]);

    await runUrdbEstimatesForSite(siteId, chainApi([flatRate('rev-2022', '2022-01-01', 0.17), flatRate('rev-2025', '2025-01-01', 0.18, 'rev-2022')]), new Date('2026-11-16T12:00:00Z'));

    expect(await actualSpans(siteId)).toEqual([
      // No stored history here, so the walked revision fills from its own start.
      { source: 'estimated', effective_from: '2022-01-01', effective_to: '2024-12-31', urdb_label: 'rev-2022' },
      { source: 'tesla', effective_from: '2025-01-01', effective_to: null, urdb_label: null },
    ]);
    const anchor = await local.database.query(`SELECT tariff_id, start_source FROM "TariffUrdbSource" WHERE site_id = $1 AND role = 'tesla_anchor'`, [siteId]);
    expect(anchor.rows).toEqual([{ tariff_id: ids[1], start_source: 'urdb' }]);
  });

  it('keeps filling around a finite owner plan added after the owner picked a public plan', async () => {
    const siteId = 's-picked-then-manual';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`, [siteId]);
    await local.database.query(`INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, urdb_plan_label, status) VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'picked', 'pending')`, [siteId]);
    const api = chainApi([flatRate('picked', '2025-01-01', 0.2)]);
    const now = new Date('2026-11-16T12:00:00Z');
    await runUrdbEstimatesForSite(siteId, api, now);
    await new TariffTimelineRepo().createManualPeriod(siteId, 'u1', {
      name: 'March Bill', effectiveFrom: '2025-03-01', effectiveTo: '2025-03-31',
      seasons: [{ name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.25, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.25, sellRate: 0.03 }] }],
    });

    const result = await runUrdbEstimatesForSite(siteId, api, now);

    expect(result.status).toBe('ready');
    expect((await actualSpans(siteId)).map(({ source, effective_from, effective_to }) => [source, effective_from, effective_to])).toEqual([
      ['estimated', '2025-01-01', '2025-02-28'],
      ['manual', '2025-03-01', '2025-03-31'],
      ['estimated', '2025-04-01', null],
    ]);
  });

  it('fills the days between the matched revision start and an owner-dated Tesla span with that revision', async () => {
    const siteId = 's-owner-dated-gap';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`, [siteId]);
    await new TariffRepo().addTariffVersion(siteId, flatTesla('Owner Dated Tesla', 0.18));
    await local.database.query(`UPDATE "Tariff" SET updated = '2025-04-01T12:00:00Z' WHERE site_id = $1`, [siteId]);
    await local.database.query(`UPDATE "TariffEffectivePeriod" SET effective_from = '2025-03-01', effective_to = NULL, updated_by_user_id = 'u1', selection_id = NULL WHERE site_id = $1`, [siteId]);

    await runUrdbEstimatesForSite(siteId, chainApi([flatRate('rev-matched', '2025-01-01', 0.18)]), new Date('2026-11-16T12:00:00Z'));

    expect(await actualSpans(siteId)).toEqual([
      { source: 'estimated', effective_from: '2025-01-01', effective_to: '2025-02-28', urdb_label: 'rev-matched' },
      { source: 'tesla', effective_from: '2025-03-01', effective_to: null, urdb_label: null },
    ]);
  });

  it('fills the latest Tesla plan name and code from Site.json when that plan is the stored one', async () => {
    const siteId = 's-plan-name-backfill';
    const content = {
      utility: 'We Energies', name: 'Residential Time-of-Use (Single-Phase, Option A)', code: 'Rg 2',
      seasons: { Summer: { fromMonth: 1, fromDay: 1, toMonth: 12, toDay: 31, tou_periods: { OFF_PEAK: { periods: [{ fromDayOfWeek: 0, toDayOfWeek: 6, fromHour: 0, fromMinute: 0, toHour: 0, toMinute: 0 }] } } } },
      energy_charges: { Summer: { rates: { OFF_PEAK: 0.4 } } },
    };
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', $2, 'We Energies', 'US', 'owner')`, [siteId, { site_name: 'Home', tariff_content_v2: content }]);
    await new TariffRepo().addTariffVersion(siteId, parseTariffContent(content as unknown as Parameters<typeof parseTariffContent>[0], 'Home'));
    // Rows stored before content hashes existed have none.
    await local.database.query(`UPDATE "Tariff" SET content_hash = NULL WHERE site_id = $1`, [siteId]);

    await runUrdbEstimatesForSite(siteId, chainApi([]), new Date('2026-11-16T12:00:00Z'));

    const tariff = await local.database.query(`SELECT plan_name, plan_code FROM "Tariff" WHERE site_id = $1`, [siteId]);
    expect(tariff.rows).toEqual([{ plan_name: 'Residential Time-of-Use (Single-Phase, Option A)', plan_code: 'Rg 2' }]);
  });

  it('removes estimates as soon as the owner says their utility is not listed', async () => {
    const siteId = 's-skip-utility-now';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`, [siteId]);
    await local.database.query(`INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, urdb_plan_label, status) VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'picked', 'pending')`, [siteId]);
    await runUrdbEstimatesForSite(siteId, { ...chainApi([flatRate('picked', '2025-01-01', 0.2)]), defaultRates: async () => [flatRate('default', '2024-01-01', 0.15)] }, new Date('2026-11-16T12:00:00Z'));
    const before = await new TariffTimelineRepo().getTimeline(siteId, 'u1');
    expect(before.periods.some(period => period.source === 'estimated')).toBe(true);

    const timeline = await new TariffTimelineRepo().setSiteUtility(siteId, 'u1', { skipped: true });

    expect(timeline.periods.filter(period => period.source === 'estimated')).toEqual([]);
    expect((timeline.referencePeriods ?? []).filter(period => period.source === 'estimated')).toEqual([]);
    expect(timeline.estimates?.status).toBe('skipped');
    const sources = await local.database.query(`SELECT count(*)::int AS n FROM "TariffUrdbSource" WHERE site_id = $1`, [siteId]);
    expect(sources.rows).toEqual([{ n: 0 }]);
    const queued = await local.database.query(`SELECT status FROM "SiteTariffReattribution" WHERE site_id = $1`, [siteId]);
    expect(queued.rows).toEqual([{ status: 'pending' }]);
  });

  describe('unavailable followed comparison plan', () => {
    const referenceRows = async (siteId: string) => (await local.database.query<{ effective_from: string; effective_to: string | null; source: string }>(
      `SELECT effective_from::text, effective_to::text, source FROM "TariffReferencePeriod" WHERE site_id = $1 ORDER BY effective_from`, [siteId])).rows;
    async function seeded(siteId: string) {
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`, [siteId]);
      await local.database.query(`INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, urdb_plan_label, status) VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'picked', 'pending')`, [siteId]);
      const base = { ...chainApi([flatRate('picked', '2025-01-01', 0.2)]), defaultRates: async () => [flatRate('default', '2024-01-01', 0.15)] };
      await runUrdbEstimatesForSite(siteId, base, new Date('2026-11-16T12:00:00Z'));
      expect((await referenceRows(siteId)).some(row => row.source === 'estimated' && row.effective_to === null)).toBe(true);
      return base;
    }

    it('lets the followed range go uncovered without rolling back the refresh', async () => {
      const siteId = 's-followed-unavailable';
      const base = await seeded(siteId);
      await local.database.query(`UPDATE "SiteUtility" SET urdb_reference_label = 'gone', urdb_reference_from = '2025-06-01', status = 'pending' WHERE site_id = $1`, [siteId]);
      const rates = [flatRate('older', '2024-06-01', 0.18), flatRate('picked', '2025-01-01', 0.2, 'older')];
      const api: UrdbApi = { ...base, ...chainApi(rates), rateByLabel: async label => label === 'gone' ? null : rates.find(rate => rate.label === label) ?? null, defaultRates: base.defaultRates };

      const result = await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T12:00:00Z'));

      expect(result.status).toBe('ready');
      const reference = await referenceRows(siteId);
      expect(reference.length).toBeGreaterThan(0);
      expect(reference.every(row => row.effective_to !== null && row.effective_to < '2025-06-01')).toBe(true);
      expect(reference[0].effective_from).toBe('2024-01-01');
      // The actual-plan estimate in the same run was applied: the picked plan now walks back to its predecessor.
      expect((await actualSpans(siteId)).map(row => [row.urdb_label, row.effective_from, row.effective_to])).toEqual([['older', '2024-06-01', '2024-12-31'], ['picked', '2025-01-01', null]]);
    });

    it('follows the label that already supplies the default from partway through', async () => {
      const siteId = 's-followed-default';
      const base = await seeded(siteId);
      await local.database.query(`UPDATE "SiteUtility" SET urdb_reference_label = 'default', urdb_reference_from = '2025-03-01', status = 'pending' WHERE site_id = $1`, [siteId]);
      const defaultRate = flatRate('default', '2024-01-01', 0.15);
      const api: UrdbApi = { ...base, rateByLabel: async label => label === 'default' ? defaultRate : base.rateByLabel(label) };

      const result = await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T12:00:00Z'));

      expect(result.status).toBe('ready');
      const reference = await referenceRows(siteId);
      expect(reference.map(row => [row.effective_from, row.effective_to])).toEqual([['2024-01-01', null]]);
      const sources = await local.database.query(`SELECT urdb_label FROM "TariffUrdbSource" WHERE site_id = $1 AND role = 'estimated_reference'`, [siteId]);
      expect(sources.rows).toEqual([{ urdb_label: 'default' }]);
    });

    it('still rejects removing reference days when no plan is followed', async () => {
      const siteId = 's-unfollowed-removal';
      const base = await seeded(siteId);
      await local.database.query(`UPDATE "SiteUtility" SET status = 'pending' WHERE site_id = $1`, [siteId]);
      const api: UrdbApi = { ...base, defaultRates: async () => [flatRate('default', '2026-01-01', 0.15)] };

      await expect(runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T12:00:00Z'))).rejects.toThrow('URDB refresh would remove previously covered days');
      expect((await referenceRows(siteId)).some(row => row.effective_from < '2026-01-01')).toBe(true);
    });
  });

  /** Two estimated revisions of one public plan, converted one after the other by dates-only edits. */
  const convertEstimateChain = async (siteId: string, name: string) => {
    await local.database.query(`INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', '{}')`, [siteId]);
    for (const [from, to, buy] of [['2023-01-01', '2023-12-31', 0.15], ['2024-01-01', null, 0.16]] as const) {
      const id = (await local.database.query<{ id: number }>(
        `INSERT INTO "Tariff"(site_id, name, version, is_current, source) VALUES ($1, $3, $2, FALSE, 'estimated') RETURNING id`, [siteId, from.slice(0, 4), name]
      )).rows[0]!.id;
      const season = (await local.database.query<{ id: number }>(
        `INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate) VALUES ($1, 'All Year', 1, 1, 12, 31, 0, 0) RETURNING id`, [id]
      )).rows[0]!.id;
      await local.database.query(`INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate, from_day_of_week, to_day_of_week, from_hour, from_minute, to_hour, to_minute) VALUES ($1, 'OFF_PEAK', $2, 0.03, 0, 6, 0, 0, 24, 0)`, [season, buy]);
      await local.database.query(`INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source) VALUES ($1, $2, $3, $4, 'estimated')`, [siteId, id, from, to]);
      await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, end_date, start_source) VALUES ($1, $2, 'estimated_actual', $3, $4, $5, 'urdb')`, [id, siteId, `rev-${from}`, from, to]);
    }
    const repo = new TariffTimelineRepo();
    const [first, second] = (await repo.getTimeline(siteId, 'u1')).periods.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    await repo.updatePeriod(siteId, first!.periodId, 'u1', { effectiveTo: '2023-12-31' });
    await repo.updatePeriod(siteId, second!.periodId, 'u1', { effectiveFrom: '2024-01-01' });
    return (await repo.getTimeline(siteId, 'u1')).periods.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).map(period => [period.source, period.name]);
  };

  it('gives a converted estimate a distinct name when an earlier revision of the same plan was already converted', async () => {
    const siteId = 's-convert-chain';
    const names = await convertEstimateChain(siteId, 'Residential Rg 1');
    const repo = new TariffTimelineRepo();
    expect(names).toEqual([['manual', 'Residential Rg 1'], ['manual', 'Residential Rg 1 (2024)']]);
    await expect(repo.createManualPeriod(siteId, 'u1', {
      name: 'residential rg 1', effectiveFrom: '2022-01-01', effectiveTo: '2022-12-31',
      seasons: [{ name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }] }],
    })).rejects.toThrow('already exists');
  });

  it('shortens a 64-character plan name to fit the year it adds', async () => {
    const name = `Residential Time-of-Use (Single-Phase, Option A) Rg 2 Extended`.padEnd(64, 'x');
    const names = await convertEstimateChain('s-convert-long-name', name);
    expect(names).toEqual([['manual', name], ['manual', `${name.slice(0, 57)} (2024)`]]);
  });

  it('reports an out-of-date Tesla plan only from the latest Tesla version', async () => {
    const siteId = 's-out-of-date-latest';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'US', 'owner')`, [siteId]);
    const tariffRepo = new TariffRepo();
    await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla Old', 0.2));
    await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla New', 0.21));
    const ids = (await local.database.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = $1 ORDER BY id`, [siteId])).rows.map(row => Number(row.id));
    await local.database.query(`UPDATE "SiteUtility" SET status = 'ready', urdb_utility = 'Wisconsin Electric Power Co' WHERE site_id = $1`, [siteId]);
    await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source, newer_urdb_label, newer_urdb_name, newer_urdb_start) VALUES ($1, $2, 'tesla_anchor', 'old', '2025-01-01', 'urdb', 'newer', 'Newer Plan', '2025-06-01')`, [ids[0], siteId]);

    const timeline = await new TariffTimelineRepo().getTimeline(siteId, 'u1');

    expect(timeline.estimates?.teslaPlanOutOfDate).toBe(false);
    expect(timeline.estimates?.newerPlanName).toBeNull();
    expect(timeline.estimates?.newerPlanStart).toBeNull();
  });

  it('reports the newer URDB revision start and the estimate freshness on the wire', async () => {
    const siteId = 's-estimate-freshness';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'US', 'owner')`, [siteId]);
    await new TariffRepo().addTariffVersion(siteId, flatTesla('Tesla Plan', 0.2));
    const teslaId = (await local.database.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = $1 AND source = 'tesla'`, [siteId])).rows[0]!.id;
    await local.database.query(`UPDATE "SiteUtility" SET status = 'ready', urdb_utility = 'Wisconsin Electric Power Co' WHERE site_id = $1`, [siteId]);
    await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source, newer_urdb_label, newer_urdb_name, newer_urdb_start) VALUES ($1, $2, 'tesla_anchor', 'old', '2024-01-01', 'urdb', 'rev-2025', 'Residential', '2025-06-01')`, [teslaId, siteId]);
    await local.database.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1`, [siteId]);
    for (const [from, to, label] of [['2023-01-01', '2023-12-31', 'rev-2023'], ['2025-06-01', null, 'rev-2025']] as const) {
      const id = (await local.database.query<{ id: number }>(
        `INSERT INTO "Tariff"(site_id, name, version, is_current, source) VALUES ($1, 'Residential', $2, FALSE, 'estimated') RETURNING id`, [siteId, from.slice(0, 4)]
      )).rows[0]!.id;
      await local.database.query(`INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source) VALUES ($1, $2, $3, $4, 'estimated')`, [siteId, id, from, to]);
      await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, end_date, start_source) VALUES ($1, $2, 'estimated_actual', $3, $4, $5, 'urdb')`, [id, siteId, label, from, to]);
    }

    const timeline = await new TariffTimelineRepo().getTimeline(siteId, 'u1');

    expect(timeline.estimates).toMatchObject({ newerPlanStart: '2025-06-01', newestRevisionStart: '2025-06-01', mayBeOutdated: true });
  });

  it('dates estimate freshness from the URDB revision, not the span clipped to the site history', async () => {
    const siteId = 's-estimate-freshness-clipped';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'US', 'owner')`, [siteId]);
    await local.database.query(`INSERT INTO "SiteUtility"(site_id, choice, status, urdb_utility) VALUES ($1, 'auto', 'ready', 'Wisconsin Electric Power Co')`, [siteId]);
    const id = (await local.database.query<{ id: number }>(
      `INSERT INTO "Tariff"(site_id, name, version, is_current, source) VALUES ($1, 'Residential', 1, TRUE, 'estimated') RETURNING id`, [siteId]
    )).rows[0]!.id;
    // History starts 2026-11-01, so the stored span starts there; the rates date from 2025-06-01.
    await local.database.query(`INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source) VALUES ($1, $2, '2026-11-01', NULL, 'estimated')`, [siteId, id]);
    await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source, revision_start) VALUES ($1, $2, 'estimated_actual', 'rev-2025', '2026-11-01', 'urdb', '2025-06-01')`, [id, siteId]);

    const timeline = await new TariffTimelineRepo().getTimeline(siteId, 'u1');

    expect(timeline.estimates).toMatchObject({ newestRevisionStart: '2025-06-01', mayBeOutdated: true });
  });

  it('starts a site\'s first Tesla plan at its first archived day and later plans at today', async () => {
    const siteId = 's-first-plan-history';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'US', 'owner')`, [siteId]);
    // Site-local midnights (America/Chicago, CST): the first archived day is 2024-03-05.
    await local.database.query(
      `INSERT INTO "EnergyDayArchive"(site_id, day_start, revision, status) VALUES
         ($1, '2024-03-05T06:00:00Z', gen_random_uuid(), 'complete'),
         ($1, '2024-03-06T06:00:00Z', gen_random_uuid(), 'complete')`,
      [siteId]
    );
    const tariffRepo = new TariffRepo();
    const flat = (name: string, rate: number) => ({
      name,
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: rate, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: rate, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });

    await tariffRepo.addTariffVersion(siteId, flat('First Stored Plan', 0.2), { name: 'EV2-A', code: 'EV2A' });

    const first = await local.database.query<{ effective_from: string; effective_to: string | null }>(
      `SELECT effective_from::text, effective_to::text FROM "TariffEffectivePeriod" WHERE site_id = $1`, [siteId]
    );
    expect(first.rows).toEqual([{ effective_from: '2024-03-05', effective_to: null }]);
    const job = await local.database.query<{ status: string; from_date: string }>(
      `SELECT status, from_date::text FROM "SiteTariffReattribution" WHERE site_id = $1`, [siteId]
    );
    // The earliest span reprices every day before it too, so the job reaches back to history start.
    expect(job.rows).toEqual([{ status: 'pending', from_date: '2015-01-01' }]);
    const utility = await local.database.query(`SELECT status FROM "SiteUtility" WHERE site_id = $1`, [siteId]);
    expect(utility.rows).toEqual([{ status: 'pending' }]);

    await tariffRepo.addTariffVersion(siteId, flat('Second Plan', 0.25));

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    const spans = await local.database.query<{ effective_from: string }>(
      `SELECT effective_from::text FROM "TariffEffectivePeriod" WHERE site_id = $1 ORDER BY effective_from`, [siteId]
    );
    expect(spans.rows.map(row => row.effective_from)).toEqual(['2024-03-05', today]);
  });

  it('skips a backfill write when the site gained a tariff after the candidate query', async () => {
    const siteId = 's-backfill-race';
    await local.database.query(`INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', '{}')`, [siteId]);
    const flat = (name: string, rate: number) => ({
      name,
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: rate, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: rate, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    });
    const repo = new TariffRepo();
    // A Tesla sync stores the newer plan first.
    expect(await repo.addTariffVersion(siteId, flat('Newer From Tesla', 0.3))).toBe(true);

    const stored = await repo.addTariffVersion(siteId, flat('Older Saved Plan', 0.2), undefined, { requireNoTariff: true });

    expect(stored).toBe(false);
    const names = await local.database.query(`SELECT name FROM "Tariff" WHERE site_id = $1`, [siteId]);
    expect(names.rows).toEqual([{ name: 'Newer From Tesla' }]);
  });

  it('backfills a site whose only rate plans are URDB estimates', async () => {
    // Seen on Prod: the estimate job gave sites with no stored Tesla plan `estimated` reference rows,
    // which hid them from the backfill even though Site.json holds their Tesla plan.
    const siteId = 's-estimated-only';
    await local.database.query(
      `INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', $2)`,
      [siteId, JSON.stringify({ tariff_content_v2: { utility: 'Utility', seasons: {} } })]
    );
    await local.database.query(
      `INSERT INTO "Tariff"(site_id, name, version, is_current, source) VALUES ($1, 'Estimated Reference', 1, false, 'estimated')`, [siteId]
    );
    const candidates = await local.database.query<{ id: string }>(STORED_TARIFF_CANDIDATES_SQL);
    expect(candidates.rows.map(row => row.id)).toContain(siteId);

    const stored = await new TariffRepo().addTariffVersion(siteId, {
      name: 'Saved Tesla Plan',
      seasons: [{
        name: 'All Year', from_month: 1, from_day: 1, to_month: 12, to_day: 31, buy_rate: 0.2, sell_rate: 0.03,
        schedules: [{ name: 'OFF_PEAK', buy_rate: 0.2, sell_rate: 0.03, from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
      }],
    }, undefined, { requireNoTariff: true });

    expect(stored).toBe(true);
    const after = await local.database.query<{ id: string }>(STORED_TARIFF_CANDIDATES_SQL);
    expect(after.rows.map(row => row.id)).not.toContain(siteId);
  });

  it('clears needs_plan once the owner adds a rate plan', async () => {
    const siteId = 's-needs-plan-cleared';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'US', 'owner')`, [siteId]);
    await local.database.query(`INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, status, next_check_at) VALUES ($1, 'Wisconsin Electric Power Co', 'auto', 'needs_plan', now() + interval '7 days')`, [siteId]);

    const timeline = await new TariffTimelineRepo().createManualPeriod(siteId, 'u1', {
      name: 'Owner Plan', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31',
      seasons: [{ name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }] }],
    });

    expect(timeline.estimates?.status).toBe('pending');
    const row = await local.database.query(`SELECT status FROM "SiteUtility" WHERE site_id = $1`, [siteId]);
    expect(row.rows).toEqual([{ status: 'pending' }]);
  });

  async function ownerHistoryTariff(siteId: string, name: string): Promise<number> {
    const id = (await local.database.query<{ id: number }>(
      `INSERT INTO "Tariff"(site_id, name, version, is_current, source) VALUES ($1, $2, 1, FALSE, 'manual') RETURNING id`, [siteId, name]
    )).rows[0]!.id;
    await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source) VALUES ($1, $2, 'owner_history', 'label-x', '2024-01-01', 'urdb')`, [id, siteId]);
    return Number(id);
  }

  it('estimateRerunKeepsOwnerHistoryRows', async () => {
    const siteId = 's-owner-history-rerun';
    const schedule = Array.from({ length: 12 }, () => Array(24).fill(0));
    const defaultRate: UrdbRate = {
      label: 'default-label', name: 'Fixed Residential', utility: 'Wisconsin Electric Power Co',
      startdate: 1_704_067_200, is_default: true,
      energyratestructure: [[{ rate: 0.18 }]], energyweekdayschedule: schedule, energyweekendschedule: schedule,
    };
    const api: UrdbApi = {
      utilityNames: async () => ['Wisconsin Electric Power Co'],
      ratesEffectiveOn: async () => [],
      rateByLabel: async () => null,
      defaultRates: async () => [defaultRate],
    };
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`, [siteId]);
    const tariffId = await ownerHistoryTariff(siteId, 'Owner History Plan');

    await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T12:00:00Z'));
    await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T12:00:00Z'));

    const rows = await local.database.query(`SELECT tariff_id, role FROM "TariffUrdbSource" WHERE site_id = $1 AND role = 'owner_history'`, [siteId]);
    expect(rows.rows).toEqual([{ tariff_id: tariffId, role: 'owner_history' }]);
  });

  it('manualPeriodWithOwnerHistoryReportsUrdbStartSource', async () => {
    const siteId = 's-owner-history-start';
    await local.database.query(`INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', '{}')`, [siteId]);
    const repo = new TariffTimelineRepo();
    const flat = (name: string): TariffPlanWriteInput => ({
      name, effectiveFrom: name === 'Plain' ? '2023-01-01' : '2024-01-01', effectiveTo: name === 'Plain' ? '2023-12-31' : '2024-12-31',
      seasons: [{ name: 'All Year', fromMonth: 1, toMonth: 12,
        weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }],
        weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 }] }],
    });
    await repo.createManualPeriod(siteId, 'u1', flat('Plain'));
    const timeline = await repo.createManualPeriod(siteId, 'u1', flat('From History'));
    const historyTariff = timeline.periods.find(period => period.name === 'From History')!.tariffId;
    await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source) VALUES ($1, $2, 'owner_history', 'label-x', '2024-01-01', 'urdb')`, [historyTariff, siteId]);

    const after = await repo.getTimeline(siteId, 'u1');

    expect(after.periods.find(period => period.name === 'From History')?.startSource).toBe('urdb');
    expect(after.periods.find(period => period.name === 'Plain')?.startSource).toBeNull();
  });

  it('timelineCarriesHistoryGuide', async () => {
    // Midday UTC: the pg driver writes `updated` in the machine's zone, so a real clock near midnight shifts first-seen a day.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-16T18:00:00Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    const siteId = 's-history-guide';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, installed, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', '2023-11-14T18:00:00Z', 'US', 'owner')`, [siteId]);
    await new TariffRepo().addTariffVersion(siteId, flatTesla('Tesla Plan', 0.2));
    // The database stamps `updated` with the real clock; pin it to the faked day.
    await local.database.query(`UPDATE "Tariff" SET updated = '2026-11-16 17:00:00' WHERE site_id = $1 AND source = 'tesla'`, [siteId]);
    await local.database.query(`UPDATE "SiteUtility" SET status = 'ready', urdb_utility = 'Wisconsin Electric Power Co' WHERE site_id = $1`, [siteId]);
    const today = siteLocalDateString(new Date(), 'America/Chicago');

    const timeline = await new TariffTimelineRepo().getTimeline(siteId, 'u1');

    const through = addCalendarDays(today, -1);
    const days = (Date.parse(`${through}T00:00:00Z`) - Date.parse('2023-11-14T00:00:00Z')) / 86_400_000 + 1;
    expect(timeline.estimates?.historyGuide).toEqual({ historyStart: '2023-11-14', fillThrough: through, unconfirmedDays: days });
  });

  it('skippedUtilityHasNoHistoryGuide', async () => {
    const siteId = 's-history-guide-skipped';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, installed) VALUES ($1, 'u1', 'America/Chicago', '{}', '2023-11-14T18:00:00Z')`, [siteId]);
    await local.database.query(`INSERT INTO "SiteUtility"(site_id, choice, status) VALUES ($1, 'skipped', 'ready')`, [siteId]);

    const timeline = await new TariffTimelineRepo().getTimeline(siteId, 'u1');

    expect(timeline.estimates?.status).toBe('skipped');
    expect(timeline.estimates?.historyGuide).toBeNull();
  });

  describe('saveRatePlanHistory', () => {
    const UTILITY = 'Wisconsin Electric Power Co';
    const seasons = (buy: number): TariffSeasonInput[] => [{ name: 'All Year', fromMonth: 1, toMonth: 12,
      weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: buy, sellRate: 0.03 }],
      weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: buy, sellRate: 0.03 }] }];
    const revision = (label: string, from: string, to: string | null, name = `Plan ${label}`, buy = 0.15): ExpandedRevision =>
      ({ label, revisionStart: from, from, to, name, seasons: seasons(buy) });
    type SpanRow = { source: string; effective_from: string; effective_to: string | null; name: string };
    const spans = async (siteId: string) => (await local.database.query<SpanRow>(
      `SELECT p.source, p.effective_from::text, p.effective_to::text, t.name FROM "TariffEffectivePeriod" p JOIN "Tariff" t ON t.id = p.tariff_id WHERE p.site_id = $1 ORDER BY p.effective_from`, [siteId])).rows;
    const ownerHistory = async (siteId: string) => (await local.database.query(
      `SELECT u.urdb_label, u.start_date::text, u.end_date::text, u.start_source, u.revision_start::text, t.source, t.created_by_user_id FROM "TariffUrdbSource" u JOIN "Tariff" t ON t.id = u.tariff_id WHERE u.site_id = $1 AND u.role = 'owner_history' ORDER BY u.start_date`, [siteId])).rows;

    /** Harrison: history from 2023-11-14, Tesla first seen 2026-04-28 and backfilled to the history start. */
    async function harrisonSite(siteId: string, tesla: 'real' | 'default' | 'none' = 'real') {
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, installed, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', '2023-11-14T18:00:00Z', 'US', 'owner')`, [siteId]);
      await local.database.query(`INSERT INTO "EnergyDayArchive"(site_id, day_start, revision, status) VALUES ($1, '2023-11-14T06:00:00Z', gen_random_uuid(), 'complete')`, [siteId]);
      if (tesla !== 'none') {
        await new TariffRepo().addTariffVersion(siteId, tesla === 'real' ? flatTesla('Tesla Plan', 0.2) : buildDefaultTariff('Default Rate'));
        await local.database.query(`UPDATE "Tariff" SET updated = '2026-04-28 17:00:00' WHERE site_id = $1 AND source = 'tesla'`, [siteId]);
      }
      await local.database.query(`INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, status) VALUES ($1, $2, 'owner', 'ready')
        ON CONFLICT (site_id) DO UPDATE SET urdb_utility = EXCLUDED.urdb_utility, choice = 'owner', status = 'ready'`, [siteId, UTILITY]);
    }

    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-16T18:00:00Z') }); });
    afterEach(() => { vi.useRealTimers(); });

    it('saveWritesManualSpansForHarrisonWindow', async () => {
      const siteId = 's-save-harrison';
      await harrisonSite(siteId);

      const timeline = await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [
        revision('a', '2023-11-14', '2023-12-31'), revision('b', '2024-01-01', '2025-05-31'), revision('c', '2025-06-01', '2026-04-27'),
      ], null);

      expect((await spans(siteId)).map(row => [row.source, row.effective_from, row.effective_to])).toEqual([
        ['manual', '2023-11-14', '2023-12-31'], ['manual', '2024-01-01', '2025-05-31'], ['manual', '2025-06-01', '2026-04-27'], ['tesla', '2026-04-28', null],
      ]);
      expect(await ownerHistory(siteId)).toEqual([
        { urdb_label: 'a', start_date: '2023-11-14', end_date: '2023-12-31', start_source: 'urdb', revision_start: '2023-11-14', source: 'manual', created_by_user_id: 'u1' },
        { urdb_label: 'b', start_date: '2024-01-01', end_date: '2025-05-31', start_source: 'urdb', revision_start: '2024-01-01', source: 'manual', created_by_user_id: 'u1' },
        { urdb_label: 'c', start_date: '2025-06-01', end_date: '2026-04-27', start_source: 'urdb', revision_start: '2025-06-01', source: 'manual', created_by_user_id: 'u1' },
      ]);
      const current = timeline.periods.find(period => period.isCurrentToday);
      expect(current).toMatchObject({ source: 'tesla', effectiveFrom: '2026-04-28', effectiveTo: null });
      expect(timeline.periods.filter(period => period.source === 'manual').every(period => period.startSource === 'urdb')).toBe(true);
      expect(timeline.estimates?.historyGuide).toBeNull();
    });

    it('saveNamesRevisionsWithYears', async () => {
      const siteId = 's-save-names';
      await harrisonSite(siteId);

      await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [
        revision('a', '2023-11-14', '2023-12-31', 'Residential Rg 2'), revision('b', '2024-01-01', '2026-04-27', 'Residential Rg 2'),
      ], null);

      expect((await spans(siteId)).filter(row => row.source === 'manual').map(row => row.name)).toEqual(['Residential Rg 2', 'Residential Rg 2 (2024)']);
    });

    it('saveSkipsDaysCoveredByManualPlans', async () => {
      const siteId = 's-save-skips-manual';
      await harrisonSite(siteId);
      const repo = new TariffTimelineRepo();
      await repo.createManualPeriod(siteId, 'u1', { name: 'Owner Spring', effectiveFrom: '2024-03-01', effectiveTo: '2024-06-30', seasons: seasons(0.11) });

      await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2023-01-01', '2024-12-31', 'Residential Rg 1')], null);

      expect((await spans(siteId)).filter(row => row.source === 'manual').map(row => [row.name, row.effective_from, row.effective_to])).toEqual([
        ['Residential Rg 1', '2023-11-14', '2024-02-29'], ['Owner Spring', '2024-03-01', '2024-06-30'], ['Residential Rg 1 (2024)', '2024-07-01', '2024-12-31'],
      ]);
    });

    it('saveNeverTouchesTeslaFromTrustedStart', async () => {
      const siteId = 's-save-trusted-start';
      await harrisonSite(siteId);

      await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2025-01-01', '2026-10-31')], null);

      expect((await spans(siteId)).map(row => [row.source, row.effective_from, row.effective_to])).toEqual([
        ['tesla', '2023-11-14', '2024-12-31'], ['manual', '2025-01-01', '2026-04-27'], ['tesla', '2026-04-28', null],
      ]);
    });

    it('saveKeepsAnOwnerDatedTeslaStart', async () => {
      const siteId = 's-save-owner-dated-tesla';
      await harrisonSite(siteId);
      await local.database.query(`UPDATE "TariffEffectivePeriod" SET effective_from = '2026-01-01', updated_by_user_id = 'u1' WHERE site_id = $1 AND source = 'tesla'`, [siteId]);
      const repo = new TariffTimelineRepo();
      expect((await repo.getTimeline(siteId, 'u1')).estimates?.historyGuide).toMatchObject({ historyStart: '2023-11-14', fillThrough: '2025-12-31', unconfirmedDays: 779 });

      await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2023-11-14', '2026-04-27')], null);

      expect((await spans(siteId)).filter(row => row.source !== 'estimated').map(row => [row.source, row.effective_from, row.effective_to])).toEqual([
        ['manual', '2023-11-14', '2025-12-31'], ['tesla', '2026-01-01', null],
      ]);
    });

    it('saveClipsToAUrdbDatedTeslaAnchor', async () => {
      const siteId = 's-save-urdb-anchor';
      await harrisonSite(siteId);
      const teslaId = (await local.database.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = $1 AND source = 'tesla'`, [siteId])).rows[0]!.id;
      await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source) VALUES ($1, $2, 'tesla_anchor', 'anchor', '2026-01-10', 'urdb')`, [teslaId, siteId]);

      await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2025-01-01', '2026-04-27')], null);

      expect((await spans(siteId)).filter(row => row.source === 'manual').map(row => [row.effective_from, row.effective_to])).toEqual([['2025-01-01', '2026-01-09']]);
    });

    it('saveQueuesOneReattribution', async () => {
      const siteId = 's-save-reattribution';
      await harrisonSite(siteId);
      await local.database.query(`DELETE FROM "SiteTariffReattribution" WHERE site_id = $1`, [siteId]);

      await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [
        revision('a', '2023-11-14', '2023-12-31'), revision('b', '2024-01-01', '2025-05-31'), revision('c', '2025-06-01', '2026-04-27'),
      ], null);

      // One enqueue: the first generation. (The queue carries an earliest span's range back to the history floor.)
      const jobs = await local.database.query(`SELECT status, generation, requested_by_user_id FROM "SiteTariffReattribution" WHERE site_id = $1`, [siteId]);
      expect(jobs.rows).toEqual([{ status: 'pending', generation: 1, requested_by_user_id: 'u1' }]);
    });

    it('saveRejectsOverTheSpanCap', async () => {
      const siteId = 's-save-cap';
      await harrisonSite(siteId);
      const days = Array.from({ length: 50 }, (_, index) => addCalendarDays('2024-01-01', index));

      await expect(new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, days.map(day => revision(day, day, day, `Plan ${day}`)), null))
        .rejects.toThrow('That’s more rate plan changes than we can save. Add the older ones in Rate Plans.');

      expect((await spans(siteId)).map(row => row.source)).toEqual(['tesla']);
      expect(await ownerHistory(siteId)).toEqual([]);
      expect((await local.database.query(`SELECT 1 FROM "Tariff" WHERE site_id = $1 AND source = 'manual'`, [siteId])).rowCount).toBe(0);
    });

    it('openPeriodBecomesThePlanPick', async () => {
      const siteId = 's-save-open-period';
      await harrisonSite(siteId, 'none');

      const timeline = await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('old', '2023-11-14', '2025-05-31')], 'open-label');

      const utility = await local.database.query(`SELECT urdb_plan_label, status, updated_by_user_id FROM "SiteUtility" WHERE site_id = $1`, [siteId]);
      expect(utility.rows).toEqual([{ urdb_plan_label: 'open-label', status: 'pending', updated_by_user_id: 'u1' }]);
      expect(timeline.estimates?.status).toBe('pending');
      expect((await spans(siteId)).map(row => [row.source, row.effective_from, row.effective_to])).toEqual([['manual', '2023-11-14', '2025-05-31']]);
      // Once the estimate job has run, the open period counts as confirmed: the offer stays gone.
      await local.database.query(`UPDATE "SiteUtility" SET status = 'ready' WHERE site_id = $1`, [siteId]);
      expect((await new TariffTimelineRepo().getTimeline(siteId, 'u1')).estimates?.historyGuide).toBeNull();
    });

    it('skippingTheUtilityKeepsOwnerHistorySources', async () => {
      const siteId = 's-save-then-skip';
      await harrisonSite(siteId);
      const repo = new TariffTimelineRepo();
      await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], null);
      const tariffId = (await local.database.query(`SELECT id FROM "Tariff" WHERE site_id = $1 AND source = 'tesla'`, [siteId])).rows[0].id;
      await local.database.query(`INSERT INTO "TariffUrdbSource" (tariff_id, site_id, role, urdb_label, start_date, start_source) VALUES ($1, $2, 'tesla_anchor', 'anchor', '2023-11-14', 'urdb')`, [tariffId, siteId]);

      await repo.setSiteUtility(siteId, 'u1', { skipped: true });

      const roles = await local.database.query(`SELECT role FROM "TariffUrdbSource" WHERE site_id = $1 ORDER BY role`, [siteId]);
      expect(roles.rows).toEqual([{ role: 'owner_history' }]);
      expect((await ownerHistory(siteId)).map(row => row.urdb_label)).toEqual(['a']);
    });

    it('defaultRateFallbackIsNotATeslaVersion', async () => {
      const siteId = 's-save-default-rate';
      await harrisonSite(siteId, 'default');

      await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('old', '2023-11-14', '2025-05-31')], 'open-label');

      const utility = await local.database.query(`SELECT urdb_plan_label FROM "SiteUtility" WHERE site_id = $1`, [siteId]);
      expect(utility.rows).toEqual([{ urdb_plan_label: 'open-label' }]);
    });

    it('openPeriodWithTeslaIsRejected', async () => {
      const siteId = 's-save-open-with-tesla';
      await harrisonSite(siteId);

      await expect(new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], 'open-label'))
        .rejects.toThrow(TariffValidationError);
      expect(await ownerHistory(siteId)).toEqual([]);
    });

    it('utilityChangedIsRejected', async () => {
      const siteId = 's-save-utility-changed';
      await harrisonSite(siteId);

      await expect(new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', 'Madison Gas & Electric Co', [revision('a', '2024-01-01', '2024-12-31')], null))
        .rejects.toThrow(UtilityChangedError);
      expect(await ownerHistory(siteId)).toEqual([]);
      expect((await spans(siteId)).map(row => row.source)).toEqual(['tesla']);
    });

    it('savedSpansAreEditableOwnerPlans', async () => {
      const siteId = 's-save-editable';
      await harrisonSite(siteId);
      const repo = new TariffTimelineRepo();
      const saved = await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31', 'Residential Rg 1')], null);
      const period = saved.periods.find(row => row.name === 'Residential Rg 1')!;
      expect(period.updatedBy).toEqual({ email: 'owner@example.com', isCurrentUser: true });

      const { timeline } = await repo.updatePeriod(siteId, period.periodId, 'u1', { effectiveTo: '2024-11-30' });
      const edited = timeline.periods.find(row => row.name === 'Residential Rg 1')!;
      expect(edited.effectiveTo).toBe('2024-11-30');
      await repo.deleteManualPeriod(siteId, edited.periodId, 'u1');

      expect((await spans(siteId)).map(row => [row.source, row.effective_from, row.effective_to])).toEqual([['tesla', '2023-11-14', null]]);
    });

    describe('fixed comparison plans', () => {
      type RefRow = { source: string; effective_from: string; effective_to: string | null; name: string; choice_kind: string | null; scope: string | null; buy: string };
      const references = async (siteId: string) => (await local.database.query<RefRow>(
        `SELECT p.source, p.effective_from::text, p.effective_to::text, t.name, s.choice_kind, s.scope,
                (SELECT min(sp.buy_rate)::text FROM "TariffSeason" sp WHERE sp.tariff_id = t.id) AS buy
         FROM "TariffReferencePeriod" p JOIN "Tariff" t ON t.id = p.tariff_id LEFT JOIN "TariffSelection" s ON s.id = p.selection_id
         WHERE p.site_id = $1 ORDER BY p.effective_from`, [siteId])).rows;
      const followed = async (siteId: string) => (await local.database.query<{ label: string | null; from: string | null }>(
        `SELECT urdb_reference_label AS label, urdb_reference_from::text AS from FROM "SiteUtility" WHERE site_id = $1`, [siteId])).rows[0];
      const publicFixed = (label: string, from: string, to: string | null, buy = 0.12): FixedComparisonWrite =>
        ({ kind: 'public', from, to, label, revisions: [revision(label, from, to, `Fixed ${label}`, buy)] });
      const manualFixed = (from: string, to: string | null, buyRate = 0.18): FixedComparisonWrite =>
        ({ kind: 'manual', from, to, name: 'My fixed plan', buyRate, sellRate: 0.02 });

      it('writesClosedFixedAsOwnerReference', async () => {
        const siteId = 's-fixed-closed';
        await harrisonSite(siteId);
        await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], null,
          [publicFixed('fx', '2024-01-01', '2024-12-31')]);
        const owner = (await references(siteId)).filter(row => row.choice_kind === 'owner');
        expect(owner.map(row => [row.effective_from, row.effective_to, row.scope, row.name])).toEqual([['2024-01-01', '2024-12-31', 'reference', 'Fixed fx']]);
      });

      it('openFixedLabelSetsFollowedLabel', async () => {
        const siteId = 's-fixed-open-label';
        await harrisonSite(siteId, 'none');
        await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], 'a-open',
          [publicFixed('fx', '2024-01-01', null)]);
        expect(await followed(siteId)).toEqual({ label: 'fx', from: '2024-01-01' });
        expect((await references(siteId)).filter(row => row.choice_kind === 'owner')).toEqual([]);
      });

      it('followingALabelClearsOwnerReferenceOverTheOpenRange', async () => {
        const siteId = 's-fixed-open-clears';
        await harrisonSite(siteId, 'none');
        const repo = new TariffTimelineRepo();
        await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], 'a-open',
          [manualFixed('2023-11-14', null)]);
        expect((await references(siteId)).filter(row => row.choice_kind === 'owner')).toHaveLength(1);
        const client = await local.database.connect();
        try {
          await client.query('BEGIN');
          await setFollowedReferenceLabelOnClient(client, siteId, 'u1', 'fx', '2025-01-01');
          await client.query('COMMIT');
        } finally { client.release(); }
        expect((await references(siteId)).filter(row => row.choice_kind === 'owner').map(row => [row.effective_from, row.effective_to])).toEqual([['2023-11-14', '2024-12-31']]);
        expect(await followed(siteId)).toEqual({ label: 'fx', from: '2025-01-01' });
      });

      it('openFixedManualIsOwnerOpenEnded', async () => {
        const siteId = 's-fixed-open-manual';
        await harrisonSite(siteId, 'none');
        await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], 'a-open',
          [manualFixed('2024-01-01', null, 0.21)]);
        const owner = (await references(siteId)).filter(row => row.choice_kind === 'owner');
        expect(owner.map(row => [row.effective_from, row.effective_to, Number(row.buy)])).toEqual([['2024-01-01', null, 0.21]]);
        expect((await followed(siteId)).label).toBeNull();
      });

      it('guideFollowMovingLaterKeepsTheEarlierFollowedRange', async () => {
        const siteId = 's-fixed-guide-moves';
        await harrisonSite(siteId, 'none');
        const api = chainApi([flatRate('fx-2024', '2024-01-01', 0.12), flatRate('fx-2025', '2025-01-01', 0.13, 'fx-2024'), flatRate('fy-2025', '2025-01-01', 0.2)]);
        const repo = new TariffTimelineRepo();
        await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], 'a-open', [publicFixed('fx-2024', '2024-01-01', null)]);
        await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T18:00:00Z'));
        await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('b', '2025-01-01', '2025-06-30')], 'b-open', [publicFixed('fy-2025', '2025-01-01', null)]);
        expect(await followed(siteId)).toEqual({ label: 'fy-2025', from: '2025-01-01' });
        expect((await references(siteId)).filter(row => row.choice_kind === 'owner').map(row => [row.effective_from, row.effective_to, row.name])).toEqual([['2024-01-01', '2024-12-31', 'Plan fx-2024']]);
      });

      it('guideFollowStartingBeforeTheLabelsOldestRevisionStaysCoveredByTheFollowedPlan', async () => {
        const siteId = 's-fixed-guide-early';
        await harrisonSite(siteId, 'none');
        const defaults = [flatRate('default', '2023-01-01', 0.15)];
        const api = { ...chainApi([flatRate('fx-2024', '2024-01-01', 0.12)]), defaultRates: async () => defaults };
        const repo = new TariffTimelineRepo();
        await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T18:00:00Z'));
        expect((await references(siteId)).some(row => row.name === 'Plan default' && row.effective_from <= '2023-12-01')).toBe(true);
        await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2023-12-01', '2024-12-31')], 'a-open', [publicFixed('fx-2024', '2023-12-01', null)]);
        expect(await followed(siteId)).toEqual({ label: 'fx-2024', from: '2023-12-01' });
        await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T18:00:00Z'));
        expect((await followed(siteId)).label).toBe('fx-2024');
        const estimated = (await references(siteId)).filter(row => row.source === 'estimated');
        expect(estimated.find(row => row.name === 'Plan fx-2024')).toMatchObject({ effective_from: '2023-12-01', effective_to: null });
        expect(estimated.filter(row => row.name === 'Plan default').every(row => (row.effective_to ?? '9') < '2023-12-01')).toBe(true);
      });

      it('changingTheUtilityClearsTheFollowedComparisonPlan', async () => {
        const siteId = 's-fixed-utility-change';
        await harrisonSite(siteId, 'none');
        await local.database.query(`UPDATE "SiteUtility" SET urdb_reference_label = 'fx', urdb_reference_from = '2025-01-01' WHERE site_id = $1`, [siteId]);
        await new TariffTimelineRepo().setSiteUtility(siteId, 'u1', { name: 'Some Other Utility' });
        expect(await followed(siteId)).toEqual({ label: null, from: null });
        await local.database.query(`UPDATE "SiteUtility" SET urdb_reference_label = 'fx', urdb_reference_from = '2025-01-01' WHERE site_id = $1`, [siteId]);
        await new TariffTimelineRepo().setSiteUtility(siteId, 'u1', { skipped: true });
        expect(await followed(siteId)).toEqual({ label: null, from: null });
      });

      it('openManualFromBeforeTheFollowedRangeClearsTheFollowedLabel', async () => {
        const siteId = 's-fixed-manual-clears-label';
        await harrisonSite(siteId, 'none');
        await local.database.query(`UPDATE "SiteUtility" SET urdb_reference_label = 'old', urdb_reference_from = '2025-01-01' WHERE site_id = $1`, [siteId]);
        await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], 'a-open',
          [manualFixed('2024-06-01', null)]);
        expect(await followed(siteId)).toEqual({ label: null, from: null });
      });

      it('absentFixedKeepsOwnerReferences', async () => {
        const siteId = 's-fixed-absent';
        await harrisonSite(siteId);
        const repo = new TariffTimelineRepo();
        await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-06-30')], null, [manualFixed('2024-01-01', '2024-06-30')]);
        const owned = `SELECT id, tariff_id, effective_from::text, effective_to::text, source, selection_id FROM "TariffReferencePeriod" WHERE site_id = $1 AND source <> 'estimated' ORDER BY id`;
        const before = await local.database.query(owned, [siteId]);
        expect(before.rows).toHaveLength(1);
        await repo.saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('b', '2024-07-01', '2024-12-31')], null);
        expect((await local.database.query(owned, [siteId])).rows).toEqual(before.rows);
      });

      it('savesWithUncoveredFixedRange', async () => {
        const siteId = 's-fixed-uncovered';
        await harrisonSite(siteId);
        await new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], null);
        expect((await spans(siteId)).filter(row => row.source === 'manual')).toHaveLength(1);
        expect(await references(siteId)).toEqual([]);
      });

      describe('editor choice of a utility plan', () => {
        const rates = [flatRate('fx-2024', '2024-01-01', 0.12), flatRate('fx-2025', '2025-01-01', 0.13, 'fx-2024')];
        const api = chainApi(rates);
        const deps = { now: () => new Date('2026-11-16T18:00:00Z'), urdb: api, monthlyUsage: async () => 600 };
        const choose = async (siteId: string, label: string, effectiveFrom: string, effectiveTo: string | null, kind: 'public' | 'manual' = 'public') => {
          const request = {
            scope: 'reference' as const,
            candidate: kind === 'public' ? { kind: 'public' as const, label } : { kind: 'manual' as const, name: `Manual ${effectiveFrom}`, seasons: seasons(0.4) },
            effectiveFrom,
            effectiveTo,
          };
          const preview = await previewTariffSelection(siteId, 'u1', request, deps);
          const commit = await commitTariffSelection(siteId, 'u1', { ...request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false }, deps);
          return { preview, commit };
        };
        const laid = async (siteId: string) => (await local.database.query<{ label: string | null; from: string; to: string | null }>(
          `SELECT u.urdb_label AS label, p.effective_from::text AS from, p.effective_to::text AS to
           FROM "TariffReferencePeriod" p JOIN "TariffUrdbSource" u ON u.tariff_id = p.tariff_id AND u.role = 'estimated_reference'
           WHERE p.site_id = $1 ORDER BY p.effective_from`, [siteId])).rows;

        it('openPublicChoiceFollowsThePlan', async () => {
          const siteId = 's-editor-follow';
          await harrisonSite(siteId, 'none');
          const { preview } = await choose(siteId, 'fx-2024', '2024-01-01', null);
          // The preview shows the plan in effect at the start over the whole open range; later revisions are laid by the estimate run.
          expect(preview.affectedIntervals.map(item => [item.effectiveFrom, item.effectiveTo, item.after?.urdbLabel])).toEqual([['2024-01-01', null, 'fx-2024']]);
          expect(await followed(siteId)).toEqual({ label: 'fx-2024', from: '2024-01-01' });
          expect((await references(siteId)).filter(row => row.choice_kind === 'owner')).toEqual([]);
          const pending = await local.database.query(`SELECT status FROM "SiteUtility" WHERE site_id = $1`, [siteId]);
          expect(pending.rows[0].status).toBe('pending');
          await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T18:00:00Z'));
          expect(await laid(siteId)).toEqual([
            { label: 'fx-2024', from: '2024-01-01', to: '2024-12-31' },
            { label: 'fx-2025', from: '2025-01-01', to: null },
          ]);
          // The first laid span is exactly what the preview reported for the start of the range.
          const [first] = await laid(siteId);
          expect([first.from, first.label]).toEqual([preview.affectedIntervals[0].effectiveFrom, preview.affectedIntervals[0].after?.urdbLabel]);
        });

        it('retryingTheSameFollowIsUnchangedButStillChecksTheUtility', async () => {
          const siteId = 's-editor-follow-retry';
          await harrisonSite(siteId, 'none');
          const request = { scope: 'reference' as const, candidate: { kind: 'public' as const, label: 'fx-2024' }, effectiveFrom: '2024-01-01', effectiveTo: null };
          const preview = await previewTariffSelection(siteId, 'u1', request, deps);
          const commitRequest = { ...request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false };
          await commitTariffSelection(siteId, 'u1', commitRequest, deps);
          expect((await commitTariffSelection(siteId, 'u1', commitRequest, deps)).unchanged).toBe(true);
          // The same follow is also an unchanged retry after estimates lay rows.
          await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T18:00:00Z'));
          expect((await commitTariffSelection(siteId, 'u1', commitRequest, deps)).unchanged).toBe(true);
          // A utility change between the pre-lock read and the locked commit is refused even for a matching follow.
          await expect(new TariffTimelineRepo().commitReviewedSelection(siteId, {
            userId: 'u1',
            commit: commitRequest,
            publicRate: { rate: rates[0], preLockUtilityName: 'Some Other Utility', medianMonthlyKwh: null },
            resolvePublicPlan: () => { throw new Error('unreachable'); },
            now: new Date('2026-11-16T18:00:00Z'),
          })).rejects.toThrow(UtilityChangedError);
        });

        it('retryingAFollowAfterAnOwnerOverrideAppearedIsAConflict', async () => {
          const siteId = 's-editor-follow-stale-override';
          await harrisonSite(siteId, 'none');
          const request = { scope: 'reference' as const, candidate: { kind: 'public' as const, label: 'fx-2024' }, effectiveFrom: '2024-01-01', effectiveTo: null };
          const preview = await previewTariffSelection(siteId, 'u1', request, deps);
          await commitTariffSelection(siteId, 'u1', { ...request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false }, deps);
          await runUrdbEstimatesForSite(siteId, api, new Date('2026-11-16T18:00:00Z'));
          const stale = { ...request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false };
          await choose(siteId, 'x', '2024-03-01', '2024-04-30', 'manual');
          await expect(commitTariffSelection(siteId, 'u1', stale, deps)).rejects.toThrow(TariffSelectionConflictError);
        });

        it('openPublicChoiceDropsOwnerReferenceRowsFromItsStart', async () => {
          const siteId = 's-editor-follow-replaces';
          await harrisonSite(siteId, 'none');
          await choose(siteId, 'x', '2023-11-14', '2024-06-30', 'manual');
          await choose(siteId, 'x', '2024-09-01', null, 'manual');
          await choose(siteId, 'fx-2024', '2025-01-01', null);
          expect((await references(siteId)).filter(row => row.choice_kind === 'owner').map(row => [row.effective_from, row.effective_to])).toEqual([['2023-11-14', '2024-06-30'], ['2024-09-01', '2024-12-31']]);
          expect(await followed(siteId)).toEqual({ label: 'fx-2024', from: '2025-01-01' });
        });

        it('closedPublicChoiceDoesNotFollow', async () => {
          const siteId = 's-editor-closed';
          await harrisonSite(siteId, 'none');
          await choose(siteId, 'fx-2024', '2024-01-01', '2024-12-31');
          expect(await followed(siteId)).toEqual({ label: null, from: null });
          expect((await references(siteId)).filter(row => row.choice_kind === 'owner').map(row => [row.effective_from, row.effective_to])).toEqual([['2024-01-01', '2024-12-31']]);
        });

        it('closedPublicChoiceExpandsAcrossThePlanRevisions', async () => {
          const siteId = 's-editor-closed-expands';
          await harrisonSite(siteId, 'none');
          const request = { scope: 'reference' as const, candidate: { kind: 'public' as const, label: 'fx-2024' }, effectiveFrom: '2024-06-01', effectiveTo: '2025-06-30' };
          const preview = await previewTariffSelection(siteId, 'u1', request, deps);
          const buyOf = (plan: { seasons: TariffSeasonInput[] } | null) => plan?.seasons[0].weekdayPeriods[0].buyRate;
          expect(preview.affectedIntervals.map(item => [item.effectiveFrom, item.effectiveTo, item.after?.urdbLabel, buyOf(item.after)])).toEqual([
            ['2024-06-01', '2024-12-31', 'fx-2024', 0.12],
            ['2025-01-01', '2025-06-30', 'fx-2025', 0.13],
          ]);
          const commit = await commitTariffSelection(siteId, 'u1', { ...request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false }, deps);
          expect(commit.selectionIds).toHaveLength(2);
          const owner = (await references(siteId)).filter(row => row.choice_kind === 'owner');
          expect(owner.map(row => [row.effective_from, row.effective_to, row.scope, row.name, Number(row.buy)])).toEqual([
            ['2024-06-01', '2024-12-31', 'reference', 'Plan fx-2024', 0.12],
            ['2025-01-01', '2025-06-30', 'reference', 'Plan fx-2025', 0.13],
          ]);
          expect(await followed(siteId)).toEqual({ label: null, from: null });
        });

        it.each([
          { change: 'label', label: 'fx-2025', from: '2025-01-01' },
          { change: 'start date', label: 'fx-2024', from: '2025-02-01' },
        ])('rejects a stale follow review with a different $change before estimates run', async ({ change, label, from }) => {
          const siteId = `s-editor-stale-${change.replace(' ', '-')}`;
          await harrisonSite(siteId, 'none');
          const first = { scope: 'reference' as const, candidate: { kind: 'public' as const, label: 'fx-2024' }, effectiveFrom: '2025-01-01', effectiveTo: null };
          const second = { ...first, candidate: { ...first.candidate, label }, effectiveFrom: from };
          await runUrdbEstimatesForSite(siteId, { ...api, defaultRates: async () => [rates[0]] }, deps.now());
          // Start with a follow so the first review changes only the field under test.
          await choose(siteId, label, from, null);
          const before = await references(siteId);
          expect(before.length).toBeGreaterThan(0);
          expect(before.every(row => row.source === 'estimated')).toBe(true);

          const firstReview = await previewTariffSelection(siteId, 'u1', first, deps);
          const secondReview = await previewTariffSelection(siteId, 'u1', second, deps);
          await commitTariffSelection(siteId, 'u1', { ...first, expectedReviewHash: firstReview.reviewHash, verifiedAgainstBill: false }, deps);

          expect(await references(siteId)).toEqual(before);
          await expect(commitTariffSelection(siteId, 'u1', { ...second, expectedReviewHash: secondReview.reviewHash, verifiedAgainstBill: false }, deps))
            .rejects.toThrow(TariffSelectionConflictError);
          expect(await followed(siteId)).toEqual({ label: 'fx-2024', from: '2025-01-01' });
        });

        it('movingTheFollowLaterKeepsTheEarlierFollowedRangeAsOwnerRows', async () => {
          const siteId = 's-editor-follow-moves';
          await harrisonSite(siteId, 'none');
          const moveRates = [...rates, flatRate('fy-2025', '2025-01-01', 0.2)];
          const moveApi = chainApi(moveRates);
          const moveDeps = { ...deps, urdb: moveApi };
          const request = { scope: 'reference' as const, candidate: { kind: 'public' as const, label: 'fx-2024' }, effectiveFrom: '2024-01-01', effectiveTo: null };
          const first = await previewTariffSelection(siteId, 'u1', request, moveDeps);
          await commitTariffSelection(siteId, 'u1', { ...request, expectedReviewHash: first.reviewHash, verifiedAgainstBill: false }, moveDeps);
          await runUrdbEstimatesForSite(siteId, moveApi, new Date('2026-11-16T18:00:00Z'));
          const move = { ...request, candidate: { kind: 'public' as const, label: 'fy-2025' }, effectiveFrom: '2025-01-01' };
          const second = await previewTariffSelection(siteId, 'u1', move, moveDeps);
          await commitTariffSelection(siteId, 'u1', { ...move, expectedReviewHash: second.reviewHash, verifiedAgainstBill: false }, moveDeps);
          expect(await followed(siteId)).toEqual({ label: 'fy-2025', from: '2025-01-01' });
          const owner = () => references(siteId).then(rows => rows.filter(row => row.choice_kind === 'owner').map(row => [row.effective_from, row.effective_to, row.name]));
          expect(await owner()).toEqual([['2024-01-01', '2024-12-31', 'Plan fx-2024']]);
          await runUrdbEstimatesForSite(siteId, moveApi, new Date('2026-11-16T18:00:00Z'));
          expect((await references(siteId)).map(row => [row.effective_from, row.effective_to, row.name, row.choice_kind])).toEqual([
            ['2024-01-01', '2024-12-31', 'Plan fx-2024', 'owner'],
            ['2025-01-01', null, 'Plan fy-2025', null],
          ]);
        });

        it('movingTheFollowLaterKeepsAFollowedPeriodThatStraddlesItsStart', async () => {
          const siteId = 's-editor-follow-straddle';
          await harrisonSite(siteId, 'none');
          const day = new Date('2026-11-16T18:00:00Z');
          const firstApi = { ...chainApi([flatRate('fy-2026', '2026-01-01', 0.2)]), defaultRates: async () => [flatRate('d', '2023-01-01', 0.12)] };
          await runUrdbEstimatesForSite(siteId, firstApi, day);
          const request = { scope: 'reference' as const, candidate: { kind: 'public' as const, label: 'd' }, effectiveFrom: '2024-01-01', effectiveTo: null };
          const firstDeps = { ...deps, urdb: { ...firstApi, rateByLabel: async (label: string) => label === 'd' ? flatRate('d', '2023-01-01', 0.12) : firstApi.rateByLabel(label) } };
          const first = await previewTariffSelection(siteId, 'u1', request, firstDeps);
          await commitTariffSelection(siteId, 'u1', { ...request, expectedReviewHash: first.reviewHash, verifiedAgainstBill: false }, firstDeps);
          await runUrdbEstimatesForSite(siteId, firstDeps.urdb, day);
          // The followed D merges with the default D into one period that starts before the follow.
          expect((await references(siteId)).map(row => [row.name, row.effective_from, row.effective_to])).toEqual([['Plan d', '2023-01-01', null]]);
          const move = { ...request, candidate: { kind: 'public' as const, label: 'fy-2026' }, effectiveFrom: '2026-01-01' };
          const nextApi = { ...firstDeps.urdb, defaultRates: async () => [flatRate('d', '2023-01-01', 0.12), flatRate('e', '2025-01-01', 0.3, 'd')] };
          const nextDeps = { ...deps, urdb: nextApi };
          const second = await previewTariffSelection(siteId, 'u1', move, nextDeps);
          await commitTariffSelection(siteId, 'u1', { ...move, expectedReviewHash: second.reviewHash, verifiedAgainstBill: false }, nextDeps);
          await runUrdbEstimatesForSite(siteId, nextApi, day);
          const rows = (await references(siteId)).map(row => [row.name, row.effective_from, row.effective_to, row.choice_kind]);
          expect(rows.filter(row => row[0] === 'Plan d' && row[3] === 'owner')).toEqual([['Plan d', '2024-01-01', '2025-12-31', 'owner']]);
          expect(rows.some(row => row[0] === 'Plan e' && (row[1] as string) < '2026-01-01')).toBe(false);
          expect(rows.filter(row => row[3] !== 'owner' && row[0] === 'Plan d').every(row => (row[2] as string) <= '2023-12-31')).toBe(true);
        });

        it('laterOpenManualChoiceStartingOnOrBeforeTheFollowedRangeClearsTheLabel', async () => {
          const siteId = 's-editor-clears-manual';
          await harrisonSite(siteId, 'none');
          await choose(siteId, 'fx-2024', '2025-01-01', null);
          await choose(siteId, 'fx-2024', '2024-06-01', null, 'manual');
          expect(await followed(siteId)).toEqual({ label: null, from: null });
        });

        it('closedRangeEntirelyBeforeFollowedRangeKeepsTheFollow', async () => {
          const siteId = 's-editor-closed-keeps';
          await harrisonSite(siteId, 'none');
          await choose(siteId, 'fx-2024', '2025-01-01', null);
          await choose(siteId, 'fx-2024', '2024-01-01', '2024-06-30');
          await choose(siteId, 'x', '2024-07-01', '2024-12-31', 'manual');
          expect(await followed(siteId)).toEqual({ label: 'fx-2024', from: '2025-01-01' });
        });

        it('closedRangeOverlappingFollowedRangeKeepsTheFollow', async () => {
          const siteId = 's-editor-closed-overlap';
          await harrisonSite(siteId, 'none');
          await choose(siteId, 'fx-2024', '2025-01-01', null);
          await choose(siteId, 'x', '2024-06-01', '2025-03-31', 'manual');
          expect(await followed(siteId)).toEqual({ label: 'fx-2024', from: '2025-01-01' });
        });

        it('openTimeOfUsePickFromBeforeTheFollowedRangeClearsTheFollowAndKeepsAnOwnerRow', async () => {
          const siteId = 's-editor-tou';
          await harrisonSite(siteId, 'none');
          await choose(siteId, 'fx-2024', '2025-01-01', null);
          const tou = flatRate('tou-1', '2024-01-01', 0.1);
          tou.energyratestructure = [[{ rate: 0.1 }], [{ rate: 0.3 }]];
          tou.energyweekdayschedule = Array.from({ length: 12 }, () => [...Array(12).fill(0), ...Array(12).fill(1)]);
          const touDeps = { ...deps, urdb: chainApi([...rates, tou]) };
          const request = { scope: 'reference' as const, candidate: { kind: 'public' as const, label: 'tou-1' }, effectiveFrom: '2024-06-01', effectiveTo: null };
          const preview = await previewTariffSelection(siteId, 'u1', request, touDeps);
          await commitTariffSelection(siteId, 'u1', { ...request, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: false }, touDeps);
          expect(await followed(siteId)).toEqual({ label: null, from: null });
          expect((await references(siteId)).filter(row => row.choice_kind === 'owner').map(row => [row.effective_from, row.effective_to])).toEqual([['2024-06-01', null]]);
        });

        it('aChoiceStartingAfterTheFollowedRangeKeepsTheLabel', async () => {
          const siteId = 's-editor-keeps-label';
          await harrisonSite(siteId, 'none');
          await choose(siteId, 'fx-2024', '2024-01-01', null);
          await choose(siteId, 'fx-2024', '2024-03-01', '2024-04-30', 'manual');
          expect(await followed(siteId)).toEqual({ label: 'fx-2024', from: '2024-01-01' });
        });

        it('followingRefusesAChangedUtility', async () => {
          const siteId = 's-editor-utility-changed';
          await harrisonSite(siteId, 'none');
          const client = await local.database.connect();
          try {
            await client.query('BEGIN');
            await expect(setFollowedReferenceLabelOnClient(client, siteId, 'u1', 'fx-2024', '2024-01-01', 'Some Other Utility')).rejects.toThrow(UtilityChangedError);
          } finally { await client.query('ROLLBACK'); client.release(); }
          expect(await followed(siteId)).toEqual({ label: null, from: null });
        });
      });

      it('aFailingFixedWriteRollsBackTheActualRows', async () => {
        const siteId = 's-fixed-rollback';
        await harrisonSite(siteId);
        await expect(new TariffTimelineRepo().saveRatePlanHistory(siteId, 'u1', UTILITY, [revision('a', '2024-01-01', '2024-12-31')], null,
          [manualFixed('2024-01-01', '2024-12-31', 99)])).rejects.toThrow(TariffValidationError);
        expect((await spans(siteId)).map(row => row.source)).toEqual(['tesla']);
        expect(await ownerHistory(siteId)).toEqual([]);
        expect(await references(siteId)).toEqual([]);
      });
    });
  });

  describe('tariff selection provenance, protection, verification, and Tesla restoration', () => {
    const seasonsInput = (buy: number, sell = 0.04): TariffSeasonInput[] => [{
      name: 'All Year',
      fromMonth: 1,
      toMonth: 12,
      weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: buy, sellRate: sell }],
      weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: buy, sellRate: sell }],
    }];

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-16T18:00:00Z') });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('migration is idempotent, enforces RLS/grants, backfills owner periods unverified, and cascades on Site delete', async () => {
      const siteId = 's-sel-mig';
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'Wisconsin Electric Power Co')`, [siteId]);
      await local.database.query(`INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, status) VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'ready')`, [siteId]);

      const repo = new TariffTimelineRepo();
      await repo.createManualPeriod(siteId, 'u1', {
        name: 'Pre-backfill Manual',
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-12-31',
        seasons: seasonsInput(0.19),
      });
      await repo.createReferencePeriod(siteId, 'u1', {
        name: 'Pre-backfill Reference',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        seasons: seasonsInput(0.14),
      });
      // Simulate rows imported before TariffSelection existed by unlinking selection_id cleanly.
      await local.database.query(`UPDATE "TariffEffectivePeriod" SET selection_id = NULL WHERE site_id = $1`, [siteId]);
      await local.database.query(`UPDATE "TariffReferencePeriod" SET selection_id = NULL WHERE site_id = $1`, [siteId]);
      await local.database.query(`DELETE FROM "TariffSelection" WHERE site_id = $1`, [siteId]);

      const migFile = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_selection_provenance.sql'));
      expect(migFile).toBeDefined();
      const migSql = await readFile(`db-migrations/${migFile!}`, 'utf8');
      await local.database.query(migSql);
      await local.database.query(migSql);

      const selRows = (await local.database.query<{ scope: string; choice_kind: string; selected_by_user_id: string | null }>(
        `SELECT scope, choice_kind, selected_by_user_id FROM "TariffSelection" WHERE site_id = $1 ORDER BY scope`,
        [siteId]
      )).rows;
      expect(selRows).toEqual([
        { scope: 'actual', choice_kind: 'owner', selected_by_user_id: 'u1' },
        { scope: 'reference', choice_kind: 'owner', selected_by_user_id: 'u1' },
      ]);
      const verRows = await local.database.query(`SELECT count(*)::int AS n FROM "TariffSelectionVerification" WHERE site_id = $1`, [siteId]);
      expect(verRows.rows).toEqual([{ n: 0 }]);

      const rlsRes = (await local.database.query<{ tablename: string; rowsecurity: boolean }>(
        `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('TariffSelection', 'TariffSelectionOriginal', 'TariffSelectionVerification')
         ORDER BY c.relname`
      )).rows;
      expect(rlsRes).toEqual([
        { tablename: 'TariffSelection', rowsecurity: true },
        { tablename: 'TariffSelectionOriginal', rowsecurity: true },
        { tablename: 'TariffSelectionVerification', rowsecurity: true },
      ]);

      await local.database.query(`DELETE FROM "Site" WHERE id = $1`, [siteId]);
      const leftovers = await local.database.query<{ n: number }>(
        `SELECT (
           (SELECT count(*) FROM "TariffSelection" WHERE site_id = $1) +
           (SELECT count(*) FROM "TariffSelectionOriginal" WHERE site_id = $1) +
           (SELECT count(*) FROM "TariffSelectionVerification" WHERE site_id = $1) +
           (SELECT count(*) FROM "TariffEffectivePeriod" WHERE site_id = $1) +
           (SELECT count(*) FROM "TariffReferencePeriod" WHERE site_id = $1)
         )::int AS n`,
        [siteId]
      );
      expect(leftovers.rows).toEqual([{ n: 0 }]);
    });

    it('protects owner-selected public plans on actual and reference scopes from estimate rebuilds, Tesla imports, and utility skip', async () => {
      const siteId = 's-sel-public-protect';
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`, [siteId]);
      await local.database.query(`INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, urdb_plan_label, status) VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'urdb-auto', 'pending')`, [siteId]);

      const repo = new TariffTimelineRepo();
      await repo.applySelection(siteId, {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        userId: 'u1',
        verifiedAgainstBill: true,
        candidate: {
          kind: 'public',
          name: 'WE Energies Public TOU',
          seasons: seasonsInput(0.175, 0.045),
          urdbLabel: 'urdb-owner-actual',
          utilityName: 'Wisconsin Electric Power Co',
          revisionStart: '2025-01-01',
          exportRateProvenance: 'published',
        },
      });
      await repo.applySelection(siteId, {
        scope: 'reference',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        userId: 'u1',
        verifiedAgainstBill: false,
        candidate: {
          kind: 'public',
          name: 'WE Energies Reference TOU',
          seasons: seasonsInput(0.135, 0.03),
          urdbLabel: 'urdb-owner-ref',
          utilityName: 'Wisconsin Electric Power Co',
          revisionStart: '2025-01-01',
          exportRateProvenance: 'published',
        },
      });

      await runUrdbEstimatesForSite(
        siteId,
        chainApi([flatRate('urdb-auto', '2024-01-01', 0.29)]),
        new Date('2026-11-16T12:00:00Z')
      );
      await new TariffRepo().addTariffVersion(siteId, flatTesla('Tesla Sync Override Attempt', 0.21));
      const skippedTimeline = await repo.setSiteUtility(siteId, 'u1', { skipped: true });

      const activeActual = skippedTimeline.periods.find(p => p.effectiveFrom === '2025-01-01' && p.effectiveTo === null);
      expect(activeActual?.source).toBe('estimated');
      expect(activeActual?.choiceKind).toBe('owner');
      expect(activeActual?.name).toBe('WE Energies Public TOU');
      expect(activeActual?.verification).toMatchObject({ verifiedByCurrentUser: true });

      const activeRef = (skippedTimeline.referencePeriods ?? []).find(p => p.effectiveFrom === '2025-01-01' && p.effectiveTo === null);
      expect(activeRef?.source).toBe('estimated');
      expect(activeRef?.choiceKind).toBe('owner');
      expect(activeRef?.name).toBe('WE Energies Reference TOU');

      const keptSources = await local.database.query<{ urdb_label: string; is_current_estimate: boolean }>(
        `SELECT urdb_label, is_current_estimate FROM "TariffUrdbSource" WHERE site_id = $1 ORDER BY urdb_label`,
        [siteId]
      );
      expect(keptSources.rows).toEqual([
        { urdb_label: 'urdb-owner-actual', is_current_estimate: false },
        { urdb_label: 'urdb-owner-ref', is_current_estimate: false },
      ]);
    });

    it('captures original Tesla versions across intervals and restores exact saved versions while remaining protected', async () => {
      const siteId = 's-sel-restore-exact';
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies', 'US', 'owner')`, [siteId]);

      const tariffRepo = new TariffRepo();
      await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla v1', 0.16));
      const t1 = (await local.database.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = $1 AND name = 'Tesla v1'`, [siteId])).rows[0]!.id;
      await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla v2', 0.2));
      const t2 = (await local.database.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = $1 AND name = 'Tesla v2'`, [siteId])).rows[0]!.id;
      await local.database.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1`, [siteId]);
      await local.database.query(
        `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source)
         VALUES ($1, $2, '2025-01-01', '2025-06-30', 'tesla'), ($1, $3, '2025-07-01', NULL, 'tesla')`,
        [siteId, t1, t2]
      );

      const repo = new TariffTimelineRepo();
      const firstOverride = await repo.applySelection(siteId, {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        userId: 'u1',
        verifiedAgainstBill: false,
        candidate: {
          kind: 'public',
          name: 'Owner Public Plan 1',
          seasons: seasonsInput(0.18),
          urdbLabel: 'urdb-p1',
          utilityName: 'Wisconsin Electric Power Co',
          revisionStart: '2025-01-01',
          exportRateProvenance: 'published',
        },
      });
      const firstSelectionId = firstOverride.selectionIds[0]!;

      // Replace again so Tesla v1 & v2 have zero effective rows and sit behind a chained override.
      await repo.applySelection(siteId, {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        userId: 'u1',
        verifiedAgainstBill: false,
        candidate: {
          kind: 'manual',
          name: 'Owner Manual Plan 2',
          seasons: seasonsInput(0.22),
        },
      });

      const activeEffectiveCountForT1 = await local.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "TariffEffectivePeriod" WHERE site_id = $1 AND tariff_id = ANY($2::int[])`,
        [siteId, [t1, t2]]
      );
      expect(activeEffectiveCountForT1.rows).toEqual([{ n: 0 }]);

      // Later Tesla import v3 arrives while the owner override is active.
      await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla v3 Newer', 0.31));

      // Restore the exact originally saved Tesla intervals (t1 & t2, never v3).
      const restored = await repo.applySelection(siteId, {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        userId: 'u1',
        verifiedAgainstBill: false,
        candidate: {
          kind: 'restore_tesla',
          originalSelectionId: firstSelectionId,
        },
      });

      expect(restored.timeline.periods.map(p => [p.source, p.choiceKind, p.tariffId, p.effectiveFrom, p.effectiveTo])).toEqual([
        ['tesla', 'owner', t2, '2025-07-01', null],
        ['tesla', 'owner', t1, '2025-01-01', '2025-06-30'],
      ]);

      // Restored Tesla spans stay protected against another newer Tesla import and URDB estimates.
      await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla v4 Even Newer', 0.39));
      await local.database.query(
        `INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, urdb_plan_label, status)
         VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'urdb-auto', 'pending')
         ON CONFLICT (site_id) DO UPDATE
         SET urdb_utility = EXCLUDED.urdb_utility, choice = EXCLUDED.choice, urdb_plan_label = EXCLUDED.urdb_plan_label, status = EXCLUDED.status`,
        [siteId]
      );
      await runUrdbEstimatesForSite(siteId, chainApi([flatRate('urdb-auto', '2025-01-01', 0.25)]), new Date('2026-11-16T12:00:00Z'));

      const afterSync = await repo.getTimeline(siteId, 'u1');
      expect(afterSync.periods.map(p => [p.source, p.choiceKind, p.tariffId, p.effectiveFrom, p.effectiveTo])).toEqual([
        ['tesla', 'owner', t2, '2025-07-01', null],
        ['tesla', 'owner', t1, '2025-01-01', '2025-06-30'],
      ]);
    });

    it('binds verification strictly to content and dates, preserves audit history across splits, and avoids duplicate versions on unchanged saves', async () => {
      const siteId = 's-sel-verify-hash';
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies')`, [siteId]);
      const repo = new TariffTimelineRepo();

      const first = await repo.applySelection(siteId, {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-12-31',
        userId: 'u1',
        verifiedAgainstBill: true,
        candidate: {
          kind: 'public',
          name: 'Verified Public Plan',
          seasons: seasonsInput(0.17),
          urdbLabel: 'urdb-v1',
          utilityName: 'Wisconsin Electric Power Co',
          revisionStart: '2025-01-01',
          exportRateProvenance: 'published',
        },
      });
      expect(first.createdNewTariffVersion).toBe(true);
      expect(first.timeline.periods[0].verification).toMatchObject({ verifiedByEmail: 'owner@example.com', verifiedByCurrentUser: true });

      const viewerU2 = await repo.getTimeline(siteId, 'u2');
      expect(viewerU2.periods[0].verification).toMatchObject({ verifiedByEmail: 'owner@example.com', verifiedByCurrentUser: false });

      // Unchanged re-save must not manufacture a duplicate Tariff version.
      const unchanged = await repo.applySelection(siteId, {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-12-31',
        userId: 'u1',
        verifiedAgainstBill: true,
        candidate: {
          kind: 'public',
          name: 'Verified Public Plan',
          seasons: seasonsInput(0.17),
          urdbLabel: 'urdb-v1',
          utilityName: 'Wisconsin Electric Power Co',
          revisionStart: '2025-01-01',
          exportRateProvenance: 'published',
        },
      });
      expect(unchanged.unchanged).toBe(true);
      expect(unchanged.createdNewTariffVersion).toBe(false);
      const tariffCount = await local.database.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Tariff" WHERE site_id = $1`, [siteId]);
      expect(tariffCount.rows).toEqual([{ n: 1 }]);

      // Splitting a middle subrange suppresses verification on the altered fragments while keeping provenance & historical verification auditable.
      const split = await repo.applySelection(siteId, {
        scope: 'actual',
        effectiveFrom: '2025-06-01',
        effectiveTo: '2025-07-31',
        userId: 'u1',
        verifiedAgainstBill: false,
        candidate: {
          kind: 'manual',
          name: 'Summer Exception',
          seasons: seasonsInput(0.28),
        },
      });
      const leftFrag = split.timeline.periods.find(p => p.effectiveFrom === '2025-01-01');
      const rightFrag = split.timeline.periods.find(p => p.effectiveFrom === '2025-08-01');
      expect(leftFrag?.choiceKind).toBe('owner');
      expect(leftFrag?.verification).toBeNull();
      expect(rightFrag?.choiceKind).toBe('owner');
      expect(rightFrag?.verification).toBeNull();

      const audit = await repo.getSelectionAuditHistory(siteId, 'actual', 'u1');
      expect(
        audit.some(
          entry =>
            entry.verification !== null &&
            entry.verification.effective_from === '2025-01-01' &&
            entry.verification.effective_to === '2025-12-31' &&
            entry.verification.verifiedByCurrentUser
        )
      ).toBe(true);
    });

    it('end-to-end PostgreSQL selection preview, commit, idempotent retry, stale 409, multi-interval restore, legacy protection, and cross-site isolation', async () => {
      const siteId = 's-sel-e2e';
      const otherSiteId = 's-sel-other';
      await local.database.query(
        `INSERT INTO "Site"(id, user_id, timezone, json, utility, installed, rate_country, rate_country_source)
         VALUES ($1, 'u1', 'America/Chicago', '{"currency":"USD"}', 'We Energies', '2023-11-14T18:00:00Z', 'US', 'owner'),
                ($2, 'u2', 'America/Chicago', '{"currency":"USD"}', 'We Energies', '2023-11-14T18:00:00Z', 'US', 'owner')`,
        [siteId, otherSiteId]
      );
      await local.database.query(
        `INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, status)
         VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'ready'),
                ($2, 'Wisconsin Electric Power Co', 'owner', 'ready')`,
        [siteId, otherSiteId]
      );
      await local.database.query(
        `INSERT INTO "EnergyDayArchive"(site_id, day_start, revision, status)
         VALUES ($1, '2024-01-01T06:00:00Z', gen_random_uuid(), 'complete')`,
        [siteId]
      );

      // Seed two historical Tesla versions on siteId and one on otherSiteId.
      const tariffRepo = new TariffRepo();
      await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla v1', 0.14));
      const t1 = (await local.database.query<{ id: number }>(
        `SELECT id FROM "Tariff" WHERE site_id = $1 AND name = 'Tesla v1'`,
        [siteId]
      )).rows[0]!.id;
      await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla v2', 0.18));
      const t2 = (await local.database.query<{ id: number }>(
        `SELECT id FROM "Tariff" WHERE site_id = $1 AND name = 'Tesla v2'`,
        [siteId]
      )).rows[0]!.id;
      await local.database.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1`, [siteId]);
      await local.database.query(
        `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source)
         VALUES ($1, $2, '2025-01-01', '2025-06-30', 'tesla'),
                ($1, $3, '2025-07-01', NULL, 'tesla')`,
        [siteId, t1, t2]
      );

      // Seed otherSiteId with an override so it owns a selectionId that must remain isolated from siteId.
      await tariffRepo.addTariffVersion(otherSiteId, flatTesla('Other Tesla', 0.25));
      const repo = new TariffTimelineRepo();
      const otherCommit = await repo.applySelection(otherSiteId, {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        userId: 'u2',
        verifiedAgainstBill: false,
        candidate: { kind: 'manual', name: 'Other Override', seasons: seasonsInput(0.29) },
      });
      const otherSiteSelectionId = otherCommit.selectionIds[0]!;

      const publicRate: UrdbRate = {
        label: 'urdb-e2e-tiered',
        name: 'WE Public Tiered',
        utility: 'Wisconsin Electric Power Co',
        startdate: 1_735_689_600,
        dgrules: 'Buy All Sell All',
        energyratestructure: [
          [{ rate: 0.1, max: 300, unit: 'kWh' }, { rate: 0.22, unit: 'kWh' }],
        ],
        energyweekdayschedule: Array.from({ length: 12 }, () => Array<number>(24).fill(0)),
        energyweekendschedule: Array.from({ length: 12 }, () => Array<number>(24).fill(0)),
      };
      const urdb = {
        ratesEffectiveOn: async () => [publicRate],
        rateByLabel: async (label: string) => (label === publicRate.label ? publicRate : null),
      };
      const fixedNow = () => new Date('2026-11-16T18:00:00Z');

      // 1. Browsing public plans supports chosen effectiveDate and explains approximations.
      const listed = await listPublicUtilityPlansForSite(
        siteId,
        { effectiveDate: '2025-03-01', now: fixedNow() },
        { repo, urdb, monthlyUsage: async () => 600 }
      );
      expect(listed.effectiveDate).toBe('2025-03-01');
      expect(listed.plans[0]).toMatchObject({
        label: 'urdb-e2e-tiered',
        name: 'WE Public Tiered',
        exportRateProvenance: 'inherited',
      });
      expect(listed.plans[0].approximationNotes.map(n => n.kind)).toEqual([
        'tier_blended',
        'export_inherited_from_tesla',
      ]);

      // 2. Preview & commit an explicit finite public plan overriding Tesla across v1 + v2.
      const previewPublic = await previewTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-e2e-tiered' },
          effectiveFrom: '2025-03-01',
          effectiveTo: '2025-09-30',
        },
        { now: fixedNow, repo, urdb, monthlyUsage: async () => 600 }
      );
      expect(previewPublic.affectedIntervals).toHaveLength(2);
      expect(previewPublic.unchangedOutsidePeriods.map(p => [p.effectiveFrom, p.effectiveTo])).toEqual([
        ['2025-01-01', '2025-02-28'],
        ['2025-10-01', null],
      ]);
      expect(previewPublic.restoration.preservedOriginals).toHaveLength(2);

      const committedPublic = await commitTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-e2e-tiered' },
          effectiveFrom: '2025-03-01',
          effectiveTo: '2025-09-30',
          expectedReviewHash: previewPublic.reviewHash,
          verifiedAgainstBill: true,
        },
        { now: fixedNow, repo, urdb, monthlyUsage: async () => 600 }
      );
      expect(committedPublic.unchanged).toBe(false);
      const overrideSelectionId = committedPublic.selectionIds[0]!;
      const activePublicPeriod = committedPublic.timeline.periods.find(p => p.effectiveFrom === '2025-03-01');
      expect(activePublicPeriod?.source).toBe('estimated');
      expect(activePublicPeriod?.choiceKind).toBe('owner');
      expect(activePublicPeriod?.verification).toMatchObject({ verifiedByCurrentUser: true });

      // 3. Immediate duplicate submission is idempotent and does not manufacture extra Tariff/Selection rows.
      const retryPublic = await commitTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'public', label: 'urdb-e2e-tiered' },
          effectiveFrom: '2025-03-01',
          effectiveTo: '2025-09-30',
          expectedReviewHash: previewPublic.reviewHash,
          verifiedAgainstBill: true,
        },
        { now: fixedNow, repo, urdb, monthlyUsage: async () => 600 }
      );
      expect(retryPublic.unchanged).toBe(true);
      expect(retryPublic.selectionIds).toEqual([overrideSelectionId]);

      await expect(
        commitTariffSelection(
          siteId,
          'u1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-e2e-tiered' },
            effectiveFrom: '2025-03-01',
            effectiveTo: '2025-09-30',
            expectedReviewHash: 'f'.repeat(64),
            verifiedAgainstBill: true,
          },
          { now: fixedNow, repo, urdb, monthlyUsage: async () => 600 }
        )
      ).rejects.toThrow(TariffSelectionConflictError);

      // 4. Legacy saveRatePlanHistory (PUT /utility/history) must NOT overwrite the owner-selected public plan.
      await repo.saveRatePlanHistory(
        siteId,
        'u1',
        'Wisconsin Electric Power Co',
        [{ label: 'hist-1', revisionStart: '2024-01-01', from: '2024-01-01', to: '2025-05-31', name: 'Legacy Hist', seasons: seasonsInput(0.11) }],
        null
      );
      const afterLegacyHistory = await repo.getTimeline(siteId, 'u1');
      const keptPublicAfterHistory = afterLegacyHistory.periods.find(p => p.effectiveFrom === '2025-03-01' && p.effectiveTo === '2025-09-30');
      expect(keptPublicAfterHistory?.source).toBe('estimated');
      expect(keptPublicAfterHistory?.choiceKind).toBe('owner');
      expect(keptPublicAfterHistory?.name).toBe('WE Public Tiered');

      // 5. Old reviewHash MUST fail with 409 Conflict after timeline changed.
      await expect(
        commitTariffSelection(
          siteId,
          'u1',
          {
            scope: 'actual',
            candidate: { kind: 'public', label: 'urdb-e2e-tiered' },
            effectiveFrom: '2025-03-01',
            effectiveTo: '2025-09-30',
            expectedReviewHash: previewPublic.reviewHash,
            verifiedAgainstBill: true,
          },
          { now: fixedNow, repo, urdb, monthlyUsage: async () => 600 }
        )
      ).rejects.toThrow(TariffSelectionConflictError);

      // 6. Legacy PATCH date-only edit on owner-selected public plan preserves source='estimated' and urdbLabel.
      const { timeline: afterDatePatch } = await repo.updatePeriod(siteId, keptPublicAfterHistory!.periodId, 'u1', {
        effectiveTo: '2025-08-31',
      });
      const patchedPublic = afterDatePatch.periods.find(p => p.effectiveFrom === '2025-03-01');
      expect(patchedPublic?.effectiveTo).toBe('2025-08-31');
      expect(patchedPublic?.source).toBe('estimated');
      expect(patchedPublic?.choiceKind).toBe('owner');
      expect(patchedPublic?.urdbLabel).toBe('urdb-e2e-tiered');

      // 6b. Reference-scope owner-selected public plan + date-only updateReferencePeriod preserves source='estimated' & urdbLabel.
      const refPreview = await previewTariffSelection(
        siteId,
        'u1',
        {
          scope: 'reference',
          candidate: { kind: 'public', label: 'urdb-e2e-tiered' },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-06-30',
        },
        { now: fixedNow, repo, urdb, monthlyUsage: async () => 600 }
      );
      const refCommit = await commitTariffSelection(
        siteId,
        'u1',
        {
          scope: 'reference',
          candidate: { kind: 'public', label: 'urdb-e2e-tiered' },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-06-30',
          expectedReviewHash: refPreview.reviewHash,
          verifiedAgainstBill: false,
        },
        { now: fixedNow, repo, urdb, monthlyUsage: async () => 600 }
      );
      const refPeriodId = refCommit.timeline.referencePeriods![0].periodId;
      const afterRefDatePatch = await repo.updateReferencePeriod(siteId, 'u1', refPeriodId, {
        effectiveTo: '2025-12-31',
      });
      expect(afterRefDatePatch.referencePeriods?.[0]).toMatchObject({
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-12-31',
        source: 'estimated',
        choiceKind: 'owner',
        urdbLabel: 'urdb-e2e-tiered',
      });

      // 7. Later Tesla import arrives while override is active, then multi-interval restore recovers exact v1 & v2.
      await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla v3 Newer', 0.35));
      const restorePreview = await previewTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: overrideSelectionId },
          effectiveFrom: '2025-03-01',
          effectiveTo: '2025-09-30',
        },
        { now: fixedNow, repo }
      );
      expect(restorePreview.restoration.canApplyRestoration).toBe(true);
      expect(restorePreview.affectedIntervals.map(i => [i.effectiveFrom, i.effectiveTo, i.after?.tariffId])).toEqual([
        ['2025-03-01', '2025-06-30', t1],
        ['2025-07-01', '2025-08-31', t2],
        ['2025-09-01', '2025-09-30', t2],
      ]);

      const restored = await commitTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: overrideSelectionId },
          effectiveFrom: '2025-03-01',
          effectiveTo: '2025-09-30',
          expectedReviewHash: restorePreview.reviewHash,
          verifiedAgainstBill: false,
        },
        { now: fixedNow, repo }
      );
      expect(restored.timeline.periods.some(p => p.tariffId === t1 && p.effectiveFrom === '2025-03-01' && p.effectiveTo === '2025-06-30' && p.choiceKind === 'owner')).toBe(true);
      expect(restored.timeline.periods.some(p => p.tariffId === t2 && p.effectiveFrom === '2025-07-01' && p.effectiveTo === '2025-09-30' && p.choiceKind === 'owner')).toBe(true);

      // 8. Cross-site originalSelectionId isolation: siteId cannot preview or commit otherSiteId's selectionId.
      const crossSitePreview = await previewTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: otherSiteSelectionId },
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-03-01',
        },
        { now: fixedNow, repo }
      );
      expect(crossSitePreview.restoration.canApplyRestoration).toBe(false);
      await expect(
        commitTariffSelection(
          siteId,
          'u1',
          {
            scope: 'actual',
            candidate: { kind: 'restore_tesla', originalSelectionId: otherSiteSelectionId },
            effectiveFrom: '2025-01-01',
            effectiveTo: '2025-03-01',
            expectedReviewHash: crossSitePreview.reviewHash,
            verifiedAgainstBill: false,
          },
          { now: fixedNow, repo }
        )
      ).rejects.toThrow(TariffValidationError);
    });
  });

  describe('site rate country & US eligibility (postgres)', () => {
    const simpleSeasons = (buy: number, sell = 0.04): TariffSeasonInput[] => [{
      name: 'All Year',
      fromMonth: 1,
      toMonth: 12,
      weekdayPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: buy, sellRate: sell }],
      weekendPeriods: [{ touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: buy, sellRate: sell }],
    }];

    it('migration is idempotent, rejects invalid country constraints, and preserves owner precedence and clearing', async () => {
      const migFile = (await readdir('db-migrations')).find(f => f.endsWith('_site_rate_country.sql'));
      expect(migFile).toBeDefined();
      const migSql = await readFile(`db-migrations/${migFile!}`, 'utf8');
      await local.database.query(migSql);
      await local.database.query(migSql);

      const siteId = 's-country-precedence';
      await local.database.query(
        `INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{"currency":"USD"}', 'We Energies')`,
        [siteId]
      );
      await expect(
        local.database.query(`UPDATE "Site" SET rate_country = 'us', rate_country_source = 'owner' WHERE id = $1`, [siteId])
      ).rejects.toThrow();
      await expect(
        local.database.query(`UPDATE "Site" SET rate_country = 'US', rate_country_source = NULL WHERE id = $1`, [siteId])
      ).rejects.toThrow();

      const repo = new TariffTimelineRepo();
      expect(await repo.getSiteRateCountry(siteId)).toEqual({
        countryCode: null,
        source: null,
        updatedAt: null,
        eligibility: 'unknown',
      });

      // solar_location sets inferred US, owner overrides to CA, stale solar_location cannot overwrite owner.
      await repo.setSiteRateCountry(siteId, 'u1', { countryCode: 'US', source: 'solar_location' });
      expect(await repo.getSiteRateCountry(siteId)).toMatchObject({ countryCode: 'US', source: 'solar_location', eligibility: 'us' });

      await repo.setSiteRateCountry(siteId, 'u1', { countryCode: 'CA', source: 'owner' });
      expect(await repo.getSiteRateCountry(siteId)).toMatchObject({ countryCode: 'CA', source: 'owner', eligibility: 'outside_us' });

      await repo.setSiteRateCountry(siteId, 'u1', { countryCode: 'US', source: 'solar_location' });
      expect(await repo.getSiteRateCountry(siteId)).toMatchObject({ countryCode: 'CA', source: 'owner', eligibility: 'outside_us' });

      // Explicit owner clearing resets country and source back to unknown, after which solar_location can infer again and also be cleared.
      await repo.setSiteRateCountry(siteId, 'u1', { countryCode: null, source: 'owner' });
      const ownerCleared = await repo.getSiteRateCountry(siteId);
      expect(ownerCleared).toMatchObject({
        countryCode: null,
        source: null,
        eligibility: 'unknown',
      });
      expect(ownerCleared.updatedAt).not.toBeNull();

      await repo.setSiteRateCountry(siteId, 'u1', { countryCode: 'US', source: 'solar_location' });
      expect(await repo.getSiteRateCountry(siteId)).toMatchObject({ countryCode: 'US', source: 'solar_location', eligibility: 'us' });

      await repo.setSiteRateCountry(siteId, 'u1', { countryCode: null, source: 'solar_location' });
      const locationCleared = await repo.getSiteRateCountry(siteId);
      expect(locationCleared).toMatchObject({
        countryCode: null,
        source: null,
        eligibility: 'unknown',
      });
      expect(locationCleared.updatedAt).not.toBeNull();
    });

    it('suppresses needs_utility for unresolved US-timezone sites and cleans dirty non-US cron rows once with zero OpenEI calls', async () => {
      const unresolvedId = 's-country-unknown-tz-us';
      const cleanOutsideId = 's-country-clean-au';
      await local.database.query(
        `INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source)
         VALUES ($1, 'u1', 'America/Chicago', '{"currency":"USD"}', 'We Energies', NULL, NULL),
                ($2, 'u1', 'Australia/Sydney', '{"currency":"AUD"}', 'AGL', 'AU', 'owner')`,
        [unresolvedId, cleanOutsideId]
      );
      await local.database.query(
        `INSERT INTO "SiteUtility"(site_id, choice, status, urdb_utility) VALUES ($1, 'auto', 'needs_utility', 'We Energies')`,
        [unresolvedId]
      );

      const repo = new TariffTimelineRepo();
      const timeline = await repo.getTimeline(unresolvedId, 'u1');
      expect(timeline.rateCountry).toMatchObject({
        countryCode: null,
        source: null,
        eligibility: 'unknown',
        hasIneligiblePublicSelection: false,
      });
      expect(timeline.estimates).toMatchObject({
        status: 'ready',
        utilityName: null,
        eligibility: 'unknown',
        needsCountryConfirmation: true,
        historyGuide: null,
      });

      const urdbSpy = {
        ratesEffectiveOn: vi.fn(async () => { throw new Error('unexpected URDB ratesEffectiveOn'); }),
        rateByLabel: vi.fn(async () => { throw new Error('unexpected URDB rateByLabel'); }),
      };
      await expect(
        listPublicUtilityPlansForSite(unresolvedId, { now: new Date('2026-11-16T18:00:00Z') }, { repo, urdb: urdbSpy })
      ).rejects.toThrow(PublicPlansIneligibleError);
      expect(urdbSpy.ratesEffectiveOn).not.toHaveBeenCalled();

      // Park all unrelated earlier sites' SiteUtility rows so cron only observes our test sites.
      await local.database.query(
        `UPDATE "Site" SET orphaned_at = now() WHERE id NOT IN ($1, $2)`,
        [unresolvedId, cleanOutsideId]
      );
      onTestFinished(async () => {
        await local.database.query(`UPDATE "Site" SET orphaned_at = NULL`);
      });

      const cronApi: UrdbApi = {
        utilityNames: vi.fn(async () => { throw new Error('unexpected OpenEI utilityNames'); }),
        ratesEffectiveOn: vi.fn(async () => { throw new Error('unexpected OpenEI ratesEffectiveOn'); }),
        rateByLabel: vi.fn(async () => null),
        defaultRates: vi.fn(async () => { throw new Error('unexpected OpenEI defaultRates'); }),
      };

      // Pass 1 picks up dirty needs_utility unresolvedId once (0 OpenEI calls), leaving cleanOutsideId untouched.
      const pass1 = await runUrdbEstimatesCron({ maxTimeMs: 5000, maxSites: 10, api: cronApi });
      expect(pass1.sites).toEqual([{ siteId: unresolvedId, status: 'ready' }]);
      expect(cronApi.utilityNames).not.toHaveBeenCalled();
      expect(cronApi.ratesEffectiveOn).not.toHaveBeenCalled();

      const afterPass1 = await local.database.query<{ status: string; next_check_at: Date | null }>(
        `SELECT status, next_check_at FROM "SiteUtility" WHERE site_id = $1`,
        [unresolvedId]
      );
      expect(afterPass1.rows).toEqual([{ status: 'ready', next_check_at: null }]);

      // Pass 2 skips both unresolvedId (now clean ready/next_check_at=NULL) and cleanOutsideId.
      const pass2 = await runUrdbEstimatesCron({ maxTimeMs: 5000, maxSites: 10, api: cronApi });
      expect(pass2.sites).toEqual([]);
    });

    it('runs a site an owner is waiting on before older cleanup and recheck rows', async () => {
      const cleanupId = 's-queue-cleanup-unknown';
      const waitingId = 's-queue-waiting-us';
      await local.database.query(
        `INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source)
         VALUES ($1, 'u1', 'America/Chicago', '{"currency":"USD"}', 'We Energies', NULL, NULL),
                ($2, 'u1', 'America/Chicago', '{"currency":"USD"}', 'We Energies', 'US', 'solar_location')`,
        [cleanupId, waitingId]
      );
      await local.database.query(
        `INSERT INTO "SiteUtility"(site_id, choice, status, urdb_utility, next_check_at, updated_at)
         VALUES ($1, 'auto', 'needs_utility', 'We Energies', 'infinity', now() - interval '2 days'),
                ($2, 'auto', 'pending', 'We Energies', NULL, now())`,
        [cleanupId, waitingId]
      );
      await local.database.query(
        `UPDATE "Site" SET orphaned_at = now() WHERE id NOT IN ($1, $2)`,
        [cleanupId, waitingId]
      );
      onTestFinished(async () => {
        await local.database.query(`UPDATE "Site" SET orphaned_at = NULL`);
      });
      const cronApi: UrdbApi = {
        utilityNames: vi.fn(async () => []),
        ratesEffectiveOn: vi.fn(async () => []),
        rateByLabel: vi.fn(async () => null),
        defaultRates: vi.fn(async () => []),
      };

      const pass = await runUrdbEstimatesCron({ maxTimeMs: 5000, maxSites: 1, api: cronApi });
      expect(pass.sites.map(site => site.siteId)).toEqual([waitingId]);
    });

    it('cleans automatic public estimates via repricing, preserves audit/manual/Tesla history and explicit owner selections for review, and rejects 409 on mid-review eligibility flips', async () => {
      const siteId = 's-country-cleanup-pg';
      await local.database.query(
        `INSERT INTO "Site"(id, user_id, timezone, json, utility, installed, rate_country, rate_country_source)
         VALUES ($1, 'u1', 'America/Chicago', '{"currency":"USD"}', 'We Energies', '2023-11-14T18:00:00Z', 'US', 'owner')`,
        [siteId]
      );

      const tariffRepo = new TariffRepo();
      await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla Anchor', 0.16));
      await local.database.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1`, [siteId]);
      const teslaTariffId = (await local.database.query<{ id: number }>(
        `SELECT id FROM "Tariff" WHERE site_id = $1 AND source = 'tesla'`,
        [siteId]
      )).rows[0]!.id;

      // Seed manual history, owner_history source, automatic estimated actual+reference coverage, and an explicit owner public selection overriding Tesla.
      const repo = new TariffTimelineRepo();
      await repo.createManualPeriod(siteId, 'u1', {
        name: 'Manual History 2024',
        effectiveFrom: '2024-01-01',
        effectiveTo: '2024-12-31',
        seasons: simpleSeasons(0.14),
      });
      const autoEstTariffId = (await local.database.query<{ id: number }>(
        `INSERT INTO "Tariff"(site_id, name, version, is_current, source) VALUES ($1, 'Auto URDB Actual', 1, FALSE, 'estimated') RETURNING id`,
        [siteId]
      )).rows[0]!.id;
      const autoRefTariffId = (await local.database.query<{ id: number }>(
        `INSERT INTO "Tariff"(site_id, name, version, is_current, source) VALUES ($1, 'Auto URDB Reference', 1, FALSE, 'estimated') RETURNING id`,
        [siteId]
      )).rows[0]!.id;
      await local.database.query(
        `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source)
         VALUES ($1, $2, '2025-01-01', '2025-05-31', 'estimated'),
                ($1, $3, '2025-06-01', NULL, 'tesla')`,
        [siteId, autoEstTariffId, teslaTariffId]
      );
      await local.database.query(
        `INSERT INTO "TariffReferencePeriod"(site_id, tariff_id, effective_from, effective_to, source)
         VALUES ($1, $2, '2025-01-01', NULL, 'estimated')`,
        [siteId, autoRefTariffId]
      );
      await local.database.query(
        `INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, end_date, start_source)
         VALUES ($1, $2, 'estimated_actual', 'auto-actual-lbl', '2025-01-01', '2025-05-31', 'urdb'),
                ($3, $2, 'estimated_reference', 'auto-ref-lbl', '2025-01-01', NULL, 'urdb')`,
        [autoEstTariffId, siteId, autoRefTariffId]
      );
      await local.database.query(
        `INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, status)
         VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'ready')
         ON CONFLICT (site_id) DO UPDATE SET urdb_utility = EXCLUDED.urdb_utility, choice = 'owner', status = 'ready'`,
        [siteId]
      );

      // Add an explicit verified owner public selection over Tesla starting 2025-06-01.
      const ownerPub = await repo.applySelection(siteId, {
        scope: 'actual',
        effectiveFrom: '2025-06-01',
        effectiveTo: null,
        userId: 'u1',
        verifiedAgainstBill: true,
        candidate: {
          kind: 'public',
          name: 'Owner Picked Public',
          seasons: simpleSeasons(0.21, 0.06),
          urdbLabel: 'owner-pub-lbl',
          utilityName: 'Wisconsin Electric Power Co',
          revisionStart: '2025-06-01',
          exportRateProvenance: 'published',
        },
      });
      const ownerSelectionId = ownerPub.selectionIds[0]!;

      // First test preview -> mid-review country flip -> commit 409 before finalizing CA cleanup.
      const fixedNow = () => new Date('2026-11-16T18:00:00Z');
      const manualPreviewBeforeFlip = await previewTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'manual', name: 'Replacement Plan', seasons: simpleSeasons(0.24) },
          effectiveFrom: '2025-06-01',
          effectiveTo: null,
        },
        { now: fixedNow, repo }
      );

      // Flip site country US -> CA via setSiteRateCountry!
      const switched = await repo.setSiteRateCountry(siteId, 'u1', { countryCode: 'CA', source: 'owner' });

      // Mid-review manual commit created before the US -> CA flip rejects with 409 conflict.
      await expect(
        commitTariffSelection(
          siteId,
          'u1',
          {
            scope: 'actual',
            candidate: { kind: 'manual', name: 'Replacement Plan', seasons: simpleSeasons(0.24) },
            effectiveFrom: '2025-06-01',
            effectiveTo: null,
            expectedReviewHash: manualPreviewBeforeFlip.reviewHash,
            verifiedAgainstBill: false,
          },
          { now: fixedNow, repo }
        )
      ).rejects.toThrow(TariffSelectionConflictError);

      // Automatic public coverage & reference coverage are removed and queued for normal repricing, while audit Tariff rows remain.
      expect(switched.reattributionRange).not.toBeNull();
      const reattr = await local.database.query<{ status: string }>(
        `SELECT status FROM "SiteTariffReattribution" WHERE site_id = $1`,
        [siteId]
      );
      expect(reattr.rows).toEqual([{ status: 'pending' }]);

      const refCount = await local.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "TariffReferencePeriod" WHERE site_id = $1`,
        [siteId]
      );
      expect(refCount.rows).toEqual([{ n: 0 }]);

      const autoActualPeriods = await local.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "TariffEffectivePeriod" WHERE site_id = $1 AND tariff_id = $2`,
        [siteId, autoEstTariffId]
      );
      expect(autoActualPeriods.rows).toEqual([{ n: 0 }]);

      const preservedAuditTariff = await local.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Tariff" WHERE site_id = $1 AND id IN ($2, $3)`,
        [siteId, autoEstTariffId, autoRefTariffId]
      );
      expect(preservedAuditTariff.rows).toEqual([{ n: 2 }]);

      // Manual history + explicit owner selection (+ originals + verification) remain preserved and flagged for review!
      expect(switched.timeline.rateCountry).toMatchObject({
        countryCode: 'CA',
        source: 'owner',
        eligibility: 'outside_us',
        hasIneligiblePublicSelection: true,
      });
      expect(switched.timeline.periods.map(p => [p.source, p.choiceKind, p.effectiveFrom, p.effectiveTo])).toEqual([
        ['estimated', 'owner', '2025-06-01', null],
        ['manual', 'owner', '2024-01-01', '2024-12-31'],
      ]);

      const verificationCount = await local.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "TariffSelectionVerification" WHERE selection_id = $1`,
        [ownerSelectionId]
      );
      expect(verificationCount.rows).toEqual([{ n: 1 }]);

      // Owner can review & commit restoring Tesla (or a manual plan) to replace the preserved ineligible public selection.
      const restorePreview = await previewTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: ownerSelectionId },
          effectiveFrom: '2025-06-01',
          effectiveTo: null,
        },
        { now: fixedNow, repo }
      );
      expect(restorePreview.restoration.canApplyRestoration).toBe(true);
      const restored = await commitTariffSelection(
        siteId,
        'u1',
        {
          scope: 'actual',
          candidate: { kind: 'restore_tesla', originalSelectionId: ownerSelectionId },
          effectiveFrom: '2025-06-01',
          effectiveTo: null,
          expectedReviewHash: restorePreview.reviewHash,
          verifiedAgainstBill: false,
        },
        { now: fixedNow, repo }
      );
      expect(restored.timeline.rateCountry?.hasIneligiblePublicSelection).toBe(false);
      expect(restored.timeline.periods.map(p => [p.source, p.choiceKind, p.tariffId])).toEqual([
        ['tesla', 'owner', teslaTariffId],
        ['manual', 'owner', expect.any(Number)],
      ]);
    });

    it('flags retained owner public selections on unknown sites without flagging automatic estimates, and skips owner-selected reference periods in cron cleanup', async () => {
      const unknownSiteId = 's-unknown-owner-vs-auto';
      const ownerRefSiteId = 's-ca-owner-ref-cron';
      await local.database.query(
        `INSERT INTO "Site"(id, user_id, timezone, json, utility, rate_country, rate_country_source)
         VALUES ($1, 'u1', 'America/Chicago', '{"currency":"USD"}', 'We Energies', NULL, NULL),
                ($2, 'u1', 'America/Toronto', '{"currency":"CAD"}', NULL, 'CA', 'owner')`,
        [unknownSiteId, ownerRefSiteId]
      );

      const repo = new TariffTimelineRepo();

      // 1. An uncleaned automatic public estimate on an unknown site has hasIneligiblePublicSelection = false.
      const autoEstTariffId = (await local.database.query<{ id: number }>(
        `INSERT INTO "Tariff"(site_id, name, version, is_current, source) VALUES ($1, 'Auto Uncleaned', 1, FALSE, 'estimated') RETURNING id`,
        [unknownSiteId]
      )).rows[0]!.id;
      await local.database.query(
        `INSERT INTO "TariffEffectivePeriod"(site_id, tariff_id, effective_from, effective_to, source)
         VALUES ($1, $2, '2025-01-01', NULL, 'estimated')`,
        [unknownSiteId, autoEstTariffId]
      );
      await local.database.query(
        `INSERT INTO "SiteUtility"(site_id, choice, status) VALUES ($1, 'auto', 'ready')`,
        [unknownSiteId]
      );
      const beforeUnknown = await repo.getTimeline(unknownSiteId, 'u1');
      expect(beforeUnknown.rateCountry).toMatchObject({
        countryCode: null,
        eligibility: 'unknown',
        hasIneligiblePublicSelection: false,
      });
      expect(beforeUnknown.estimates?.hasIneligiblePublicSelection).toBe(false);

      // 2. Replace automatic estimate with an explicit owner public selection while country stays unknown ('unknown').
      await local.database.query(`DELETE FROM "TariffEffectivePeriod" WHERE site_id = $1`, [unknownSiteId]);
      await repo.applySelection(unknownSiteId, {
        scope: 'actual',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        userId: 'u1',
        verifiedAgainstBill: false,
        candidate: {
          kind: 'public',
          name: 'Owner Public While Unknown',
          seasons: simpleSeasons(0.21, 0.05),
          urdbLabel: 'urdb-owner-unknown',
          utilityName: 'We Energies',
          revisionStart: '2025-01-01',
          exportRateProvenance: 'published',
        },
      });
      const unknownWithOwner = await repo.getTimeline(unknownSiteId, 'u1');
      expect(unknownWithOwner.rateCountry).toMatchObject({
        countryCode: null,
        eligibility: 'unknown',
        hasIneligiblePublicSelection: true,
      });
      expect(unknownWithOwner.estimates).toMatchObject({
        eligibility: 'unknown',
        needsCountryConfirmation: true,
        hasIneligiblePublicSelection: true,
      });

      // 3. Outside-US site with ONLY an owner-selected public reference period (even with updated_by_user_id IS NULL)
      //    must NOT be picked up as dirty automatic cleanup by runUrdbEstimatesCron.
      await local.database.query(
        `INSERT INTO "SiteUtility"(site_id, choice, status, next_check_at) VALUES ($1, 'auto', 'ready', NULL)`,
        [ownerRefSiteId]
      );
      await repo.applySelection(ownerRefSiteId, {
        scope: 'reference',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        userId: 'u1',
        verifiedAgainstBill: false,
        candidate: {
          kind: 'public',
          name: 'Owner Reference Public',
          seasons: simpleSeasons(0.19, 0.04),
          urdbLabel: 'urdb-owner-ref',
          utilityName: 'We Energies',
          revisionStart: '2025-01-01',
          exportRateProvenance: 'published',
        },
      });
      await local.database.query(
        `UPDATE "TariffReferencePeriod" SET updated_by_user_id = NULL WHERE site_id = $1`,
        [ownerRefSiteId]
      );

      await local.database.query(`UPDATE "Site" SET orphaned_at = now() WHERE id <> $1`, [ownerRefSiteId]);
      onTestFinished(async () => {
        await local.database.query(`UPDATE "Site" SET orphaned_at = NULL`);
      });
      const cronApi: UrdbApi = {
        utilityNames: vi.fn(async () => { throw new Error('unexpected OpenEI utilityNames'); }),
        ratesEffectiveOn: vi.fn(async () => { throw new Error('unexpected OpenEI ratesEffectiveOn'); }),
        rateByLabel: vi.fn(async () => null),
        defaultRates: vi.fn(async () => { throw new Error('unexpected OpenEI defaultRates'); }),
      };
      const cronRes = await runUrdbEstimatesCron({ maxTimeMs: 5000, maxSites: 10, api: cronApi });
      expect(cronRes.sites).toEqual([]);
      const refPeriodStillThere = await local.database.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "TariffReferencePeriod" WHERE site_id = $1`,
        [ownerRefSiteId]
      );
      expect(refPeriodStillThere.rows).toEqual([{ n: 1 }]);
    });
  });
});
