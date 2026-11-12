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

import { TariffRepo } from './tariff-repo';
import { recomputeIsCurrentTariff, TariffTimelineRepo } from './tariff-timeline-repo';

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
});
