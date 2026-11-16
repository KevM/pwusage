import { effectiveTariffIdSql } from './effective-tariff-sql';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import {
  activityTestSocket,
  ensureRoles,
  safeActivityTestSocket,
} from './battery-hold-activity-test-db';

const local = vi.hoisted(() => ({ database: undefined as unknown as Pool }));
vi.mock('./db', () => ({
  pool: {
    query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
    connect: () => local.database.connect(),
  },
}));

import { parseTariffContent } from './importer/tariff-parser';
import { TariffRepo } from './tariff-repo';
import { recomputeIsCurrentTariff, TariffTimelineRepo } from './tariff-timeline-repo';
import { runUrdbEstimatesForSite } from './urdb/estimate-job';
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
    const admin = new Pool({
      host: activityTestSocket,
      port: 55440,
      user: process.env.USER,
      database: 'postgres',
      max: 1,
    });
    const dbName = 'tariff_timeline_repo_test';
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    local.database = new Pool({
      host: activityTestSocket,
      port: 55440,
      user: process.env.USER,
      database: dbName,
      max: 3,
    });
    await ensureRoles(local.database, ['anon', 'authenticated', 'service_role']);

    await local.database.query(`
      CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE "Site" (id TEXT PRIMARY KEY, user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL, timezone TEXT NOT NULL, json JSONB);
      CREATE TABLE "Tariff" (
        id SERIAL PRIMARY KEY, site_id TEXT NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
        updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        is_current BOOLEAN NOT NULL DEFAULT true, content_hash TEXT
      );
      CREATE UNIQUE INDEX tariff_site_name_version_uidx ON "Tariff"(site_id, name, version);
      CREATE UNIQUE INDEX tariff_current_uidx ON "Tariff"(site_id, name) WHERE is_current;
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
      CREATE TABLE "EnergyDayArchive" (site_id TEXT NOT NULL, day_start TIMESTAMPTZ NOT NULL, revision UUID NOT NULL, status TEXT, PRIMARY KEY (site_id, day_start));
      INSERT INTO "User" VALUES ('u1', 'owner@example.com'), ('u2', 'member@example.com');
      INSERT INTO "Site" VALUES ('s1', 'u1', 'America/Chicago', '{"currency":"USD"}');
    `);

    const migFile = (await readdir('db-migrations')).find(f => f.endsWith('_historic_effective_tariffs.sql'));
    if (!migFile) throw new Error('Migration missing');
    await local.database.query(await readFile(`db-migrations/${migFile}`, 'utf8'));
    const referenceMigration = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_reference_periods.sql'));
    if (!referenceMigration) throw new Error('Reference migration missing');
    await local.database.query(await readFile(`db-migrations/${referenceMigration}`, 'utf8'));
    const estimateMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_estimated_rate_plans.sql'));
    if (!estimateMigration) throw new Error('URDB estimate migration missing');
    await local.database.query(await readFile(`db-migrations/${estimateMigration}`, 'utf8'));

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
       VALUES ('s7', 'Flat Reference', 2, FALSE, 'manual') RETURNING id`
    );
    const refTariffId = refTariffRes.rows[0].id;

    // Overlapping a Tesla span in TariffEffectivePeriod is accepted in TariffReferencePeriod.
    await local.database.query(
      `INSERT INTO "TariffReferencePeriod"(site_id, tariff_id, effective_from, effective_to, updated_by_user_id)
       VALUES ('s7', $1, '2024-01-01', NULL, 'u1')`,
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
      `INSERT INTO "Site"(id, user_id, timezone, json, utility)
       VALUES ('s-unknown-utility', 'u1', 'America/Chicago', '{}', 'Unlisted Local Utility')`
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
      `INSERT INTO "Site"(id, user_id, timezone, json, utility)
       VALUES ('s-picked-estimate', 'u1', 'America/Chicago', '{}', 'We Energies')`
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
      `INSERT INTO "Site"(id, user_id, timezone, json, utility)
       VALUES ('s-owner-edit-during-fetch', 'u1', 'America/Chicago', '{}', 'We Energies')`
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
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies')`, [siteId]);
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
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies')`, [siteId]);
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
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies')`, [siteId]);
    await new TariffRepo().addTariffVersion(siteId, flatTesla('Owner Dated Tesla', 0.18));
    await local.database.query(`UPDATE "Tariff" SET updated = '2025-04-01T12:00:00Z' WHERE site_id = $1`, [siteId]);
    await local.database.query(`UPDATE "TariffEffectivePeriod" SET effective_from = '2025-03-01', effective_to = NULL, updated_by_user_id = 'u1' WHERE site_id = $1`, [siteId]);

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
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', $2, 'We Energies')`, [siteId, { site_name: 'Home', tariff_content_v2: content }]);
    await new TariffRepo().addTariffVersion(siteId, parseTariffContent(content as unknown as Parameters<typeof parseTariffContent>[0], 'Home'));
    // Rows stored before content hashes existed have none.
    await local.database.query(`UPDATE "Tariff" SET content_hash = NULL WHERE site_id = $1`, [siteId]);

    await runUrdbEstimatesForSite(siteId, chainApi([]), new Date('2026-11-16T12:00:00Z'));

    const tariff = await local.database.query(`SELECT plan_name, plan_code FROM "Tariff" WHERE site_id = $1`, [siteId]);
    expect(tariff.rows).toEqual([{ plan_name: 'Residential Time-of-Use (Single-Phase, Option A)', plan_code: 'Rg 2' }]);
  });

  it('removes estimates as soon as the owner says their utility is not listed', async () => {
    const siteId = 's-skip-utility-now';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies')`, [siteId]);
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
    await local.database.query(`INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', '{}')`, [siteId]);
    const tariffRepo = new TariffRepo();
    await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla Old', 0.2));
    await tariffRepo.addTariffVersion(siteId, flatTesla('Tesla New', 0.21));
    const ids = (await local.database.query<{ id: number }>(`SELECT id FROM "Tariff" WHERE site_id = $1 ORDER BY id`, [siteId])).rows.map(row => Number(row.id));
    await local.database.query(`UPDATE "SiteUtility" SET status = 'ready', urdb_utility = 'Wisconsin Electric Power Co' WHERE site_id = $1`, [siteId]);
    await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source, newer_urdb_label, newer_urdb_name) VALUES ($1, $2, 'tesla_anchor', 'old', '2025-01-01', 'urdb', 'newer', 'Newer Plan')`, [ids[0], siteId]);

    const timeline = await new TariffTimelineRepo().getTimeline(siteId, 'u1');

    expect(timeline.estimates?.teslaPlanOutOfDate).toBe(false);
    expect(timeline.estimates?.newerPlanName).toBeNull();
  });

  it('clears needs_plan once the owner adds a rate plan', async () => {
    const siteId = 's-needs-plan-cleared';
    await local.database.query(`INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', '{}')`, [siteId]);
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
});
