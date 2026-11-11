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
import { TariffTimelineRepo } from './tariff-timeline-repo';

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
});
