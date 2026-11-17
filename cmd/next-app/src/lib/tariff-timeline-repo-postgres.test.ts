import { effectiveTariffIdSql } from './effective-tariff-sql';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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

import { buildDefaultTariff, parseTariffContent } from './importer/tariff-parser';
import { STORED_TARIFF_CANDIDATES_SQL } from './importer/stored-tariff-backfill';
import { TariffRepo } from './tariff-repo';
import { recomputeIsCurrentTariff, TariffTimelineRepo, UtilityChangedError } from './tariff-timeline-repo';
import type { TariffSeasonInput } from './tariff-contract';
import type { ExpandedRevision } from './urdb/history-expand';
import type { TariffPlanWriteInput } from './tariff-timeline';
import { siteLocalDateString, addCalendarDays, TariffValidationError } from './tariff-timeline';
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
      CREATE TABLE "Site" (id TEXT PRIMARY KEY, user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL, timezone TEXT NOT NULL, json JSONB, installed TIMESTAMPTZ);
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
    const newerStartMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_newer_plan_start.sql'));
    if (!newerStartMigration) throw new Error('URDB newer plan start migration missing');
    await local.database.query(await readFile(`db-migrations/${newerStartMigration}`, 'utf8'));
    const revisionStartMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_revision_start.sql'));
    if (!revisionStartMigration) throw new Error('URDB revision start migration missing');
    await local.database.query(await readFile(`db-migrations/${revisionStartMigration}`, 'utf8'));
    const ownerHistoryMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_owner_history.sql'));
    if (!ownerHistoryMigration) throw new Error('URDB owner history migration missing');
    await local.database.query(await readFile(`db-migrations/${ownerHistoryMigration}`, 'utf8'));
    const selectionProvenanceMigration = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_selection_provenance.sql'));
    if (!selectionProvenanceMigration) throw new Error('Tariff selection provenance migration missing');
    await local.database.query(await readFile(`db-migrations/${selectionProvenanceMigration}`, 'utf8'));

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
    const newerStartMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_newer_plan_start.sql'));
    if (!newerStartMigration) throw new Error('URDB newer plan start migration missing');
    await local.database.query(await readFile(`db-migrations/${newerStartMigration}`, 'utf8'));
    const revisionStartMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_revision_start.sql'));
    if (!revisionStartMigration) throw new Error('URDB revision start migration missing');
    await local.database.query(await readFile(`db-migrations/${revisionStartMigration}`, 'utf8'));
    const ownerHistoryMigration = (await readdir('db-migrations')).find(f => f.endsWith('_urdb_owner_history.sql'));
    if (!ownerHistoryMigration) throw new Error('URDB owner history migration missing');
    await local.database.query(await readFile(`db-migrations/${ownerHistoryMigration}`, 'utf8'));
    const selectionProvenanceMigration = (await readdir('db-migrations')).find(f => f.endsWith('_tariff_selection_provenance.sql'));
    if (!selectionProvenanceMigration) throw new Error('Tariff selection provenance migration missing');
    await local.database.query(await readFile(`db-migrations/${selectionProvenanceMigration}`, 'utf8'));
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

  it('leaves a site outside the US ready with no estimates and no OpenEI calls', async () => {
    const siteId = 's-outside-us';
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'Australia/Sydney', '{}', 'AGL')`, [siteId]);
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
    await local.database.query(`INSERT INTO "TariffUrdbSource"(tariff_id, site_id, role, urdb_label, start_date, start_source, newer_urdb_label, newer_urdb_name, newer_urdb_start) VALUES ($1, $2, 'tesla_anchor', 'old', '2025-01-01', 'urdb', 'newer', 'Newer Plan', '2025-06-01')`, [ids[0], siteId]);

    const timeline = await new TariffTimelineRepo().getTimeline(siteId, 'u1');

    expect(timeline.estimates?.teslaPlanOutOfDate).toBe(false);
    expect(timeline.estimates?.newerPlanName).toBeNull();
    expect(timeline.estimates?.newerPlanStart).toBeNull();
  });

  it('reports the newer URDB revision start and the estimate freshness on the wire', async () => {
    const siteId = 's-estimate-freshness';
    await local.database.query(`INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', '{}')`, [siteId]);
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
    await local.database.query(`INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', '{}')`, [siteId]);
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
    await local.database.query(`INSERT INTO "Site" VALUES ($1, 'u1', 'America/Chicago', '{}')`, [siteId]);
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
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies')`, [siteId]);
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
    await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, installed) VALUES ($1, 'u1', 'America/Chicago', '{}', '2023-11-14T18:00:00Z')`, [siteId]);
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
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, installed) VALUES ($1, 'u1', 'America/Chicago', '{}', '2023-11-14T18:00:00Z')`, [siteId]);
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
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies')`, [siteId]);
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
      await local.database.query(`INSERT INTO "Site"(id, user_id, timezone, json, utility) VALUES ($1, 'u1', 'America/Chicago', '{}', 'We Energies')`, [siteId]);

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
      await local.database.query(`INSERT INTO "SiteUtility"(site_id, urdb_utility, choice, urdb_plan_label, status) VALUES ($1, 'Wisconsin Electric Power Co', 'owner', 'urdb-auto', 'pending')`, [siteId]);
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
  });
});
