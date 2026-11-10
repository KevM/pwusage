import { afterAll, describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const local = vi.hoisted(() => ({ database: undefined as unknown as import('pg').Pool }));
vi.mock('./db', () => ({ pool: {
  query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
  connect: () => local.database.connect(),
} }));

import { AccountDeletionRepo, ActiveBatterySaverError } from './account-deletion-repo';
import { createActivityTestDatabase, safeActivityTestSocket as safeSocket } from './battery-hold-activity-test-db';

// Mirrors the production foreign keys for the tables this test creates by hand.
const TARIFF_TABLES = `
  CREATE TABLE "Tariff" (id serial PRIMARY KEY, site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE);
  CREATE TABLE "TariffSeason" (id serial PRIMARY KEY, tariff_id int NOT NULL REFERENCES "Tariff"(id) ON DELETE CASCADE);
  CREATE TABLE "TariffSchedule" (id serial PRIMARY KEY, season_id int NOT NULL REFERENCES "TariffSeason"(id) ON DELETE CASCADE);`;
const ARCHIVE_TABLE = `
  CREATE TABLE "EnergyDayArchive" (
    site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE, day_start date NOT NULL, revision int NOT NULL,
    PRIMARY KEY (site_id, day_start, revision));`;
const OTHER_TABLES = `
  ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS refresh_token text,
    ADD COLUMN IF NOT EXISTS auth_status text,
    ADD COLUMN IF NOT EXISTS email text,
    ADD COLUMN IF NOT EXISTS tesla_refresh_state text DEFAULT 'ready';
  ALTER TABLE "Site"
    ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Home',
    ADD COLUMN IF NOT EXISTS json jsonb;
  CREATE TABLE "EnergyDaySummary" (
    site_id text NOT NULL, day_start date NOT NULL, revision int NOT NULL,
    tariff_id int NOT NULL REFERENCES "Tariff"(id), tariff_schedule_id int REFERENCES "TariffSchedule"(id),
    FOREIGN KEY (site_id, day_start, revision) REFERENCES "EnergyDayArchive"(site_id, day_start, revision) ON DELETE CASCADE);
  CREATE TABLE "LoadTag" (id serial PRIMARY KEY, site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE);
  CREATE TABLE "TrmnlInstallation" (id serial PRIMARY KEY, site_id text NOT NULL);
  CREATE TABLE "MobileLoginHandoff" (id serial PRIMARY KEY, user_id text NOT NULL);
  CREATE TABLE "SystemAnnouncement" (id serial PRIMARY KEY, author_id text REFERENCES "User"(id));`;

async function applyMigrationsTwice(): Promise<void> {
  const siteMemberSql = await readFile('db-migrations/20261109135834_add_site_member.sql', 'utf8');
  await local.database.query(siteMemberSql);
  await local.database.query(siteMemberSql);

  const file = (await readdir('db-migrations')).find(name => name.endsWith('_user_account_deletion_cascades.sql'));
  if (!file) throw new Error('Migration not found');
  const sql = await readFile(`db-migrations/${file}`, 'utf8');
  await local.database.query(sql);
  await local.database.query(sql);
}

async function seedAccount(userId: string, siteId: string, name = 'Home'): Promise<void> {
  const db = local.database;
  await db.query('INSERT INTO "User" (id, refresh_token, auth_status) VALUES ($1, $2, \'active\')', [userId, `rt-${userId}`]);
  await db.query(
    'INSERT INTO "Site" (id, user_id, name, tesla_hardware_id, tesla_connection_user_id) VALUES ($1, $2, $3, $4, NULL)',
    [siteId, userId, name, `hw-${siteId}`],
  );
  await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES ($1, $2, $1)', [siteId, userId]);
  await db.query('UPDATE "Site" SET tesla_connection_user_id = $1 WHERE id = $2', [userId, siteId]);
  const tariff = (await db.query('INSERT INTO "Tariff" (site_id) VALUES ($1) RETURNING id', [siteId])).rows[0].id;
  const season = (await db.query('INSERT INTO "TariffSeason" (tariff_id) VALUES ($1) RETURNING id', [tariff])).rows[0].id;
  const schedule = (await db.query('INSERT INTO "TariffSchedule" (season_id) VALUES ($1) RETURNING id', [season])).rows[0].id;
  await db.query(`INSERT INTO "EnergyDayArchive" VALUES ($1, '2026-01-01', 1)`, [siteId]);
  await db.query(`INSERT INTO "EnergyDaySummary" VALUES ($1, '2026-01-01', 1, $2, $3)`, [siteId, tariff, schedule]);
  await db.query('INSERT INTO "LoadTag" (site_id) VALUES ($1)', [siteId]);
  await db.query('INSERT INTO "TrmnlInstallation" (site_id, installed_by_user_id) VALUES ($1, $2)', [siteId, userId]);
  await db.query('INSERT INTO "MobileLoginHandoff" (user_id) VALUES ($1)', [userId]);
  await db.query('INSERT INTO "SystemAnnouncement" (author_id) VALUES ($1)', [userId]);
}

const countFor = async (table: string, column: string, value: string): Promise<number> =>
  Number((await local.database.query(`SELECT count(*) FROM "${table}" WHERE ${column} = $1`, [value])).rows[0].count);

const insertActiveHold = (siteId: string, startedBy = 'leaving') => local.database.query(`
  INSERT INTO "BatteryHold" (site_id, status, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at, started_by_user_id)
  VALUES ($1, 'active', 20, 100, 90, 500, now() + interval '1 hour', $2)`, [siteId, startedBy]);

describe.skipIf(!safeSocket)('AccountDeletionRepo isolated PostgreSQL', () => {
  afterAll(async () => { await local.database?.end(); });

  // Trigger firing order follows creation order, and the plain Site cascade fails when
  // Tariff fires before EnergyDayArchive. Production has that order; both must work.
  describe.each([
    ['tariff_first', TARIFF_TABLES + ARCHIVE_TABLE],
    ['archive_first', ARCHIVE_TABLE + TARIFF_TABLES],
  ])('with foreign keys created %s', (order, tables) => {
    it('removes a sole-member site and everything the account owns, leaving other accounts alone', async () => {
      await local.database?.end();
      local.database = await createActivityTestDatabase(`account_deletion_${order}`);
      await local.database.query(tables + OTHER_TABLES);
      await applyMigrationsTwice();
      await seedAccount('leaving', 'site-a');
      await seedAccount('staying', 'site-b');
      // Also verify a legacy TRMNL row with installed_by_user_id IS NULL cascades with a deleted site.
      await local.database.query('INSERT INTO "TrmnlInstallation" (site_id, installed_by_user_id) VALUES ($1, NULL)', ['site-a']);

      const result = await new AccountDeletionRepo().deleteAccount('leaving');

      expect(result).toEqual({ deletedSiteIds: ['site-a'], survivingSiteIds: [] });
      expect(await countFor('User', 'id', 'leaving')).toBe(0);
      expect(await countFor('Site', 'id', 'site-a')).toBe(0);
      for (const table of ['SiteMember', 'Tariff', 'EnergyDayArchive', 'EnergyDaySummary', 'LoadTag', 'TrmnlInstallation']) {
        expect(await countFor(table, 'site_id', 'site-a'), table).toBe(0);
        expect(await countFor(table, 'site_id', 'site-b'), table).toBe(1);
      }
      expect(await countFor('MobileLoginHandoff', 'user_id', 'leaving')).toBe(0);
      expect(await countFor('MobileLoginHandoff', 'user_id', 'staying')).toBe(1);
      expect(Number((await local.database.query('SELECT count(*) FROM "SystemAnnouncement" WHERE author_id IS NULL')).rows[0].count)).toBe(1);
    });

    it('keeps a shared site and its history when another member remains, removing only the departing member and their TRMNL device', async () => {
      const db = local.database;
      await seedAccount('member-1', 'site-shared', 'Shared Home');
      await db.query('INSERT INTO "User" (id, refresh_token, auth_status, email) VALUES (\'member-2\', \'rt-2\', \'active\', \'two@example.com\')');
      await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES (\'site-shared\', \'member-2\', \'site-shared-2\')');
      await db.query('INSERT INTO "TrmnlInstallation" (site_id, installed_by_user_id) VALUES (\'site-shared\', \'member-2\')');

      const overview = await new AccountDeletionRepo().getSitesForDeletion('member-1');
      expect(overview).toEqual([
        { id: 'site-shared', name: 'Shared Home', shared: true, hasOtherUsableMember: true, otherMembers: ['two@example.com'], activeHoldOriginalReserve: null },
      ]);

      const result = await new AccountDeletionRepo().deleteAccount('member-1');
      expect(result).toEqual({ deletedSiteIds: [], survivingSiteIds: ['site-shared'] });
      expect(await countFor('User', 'id', 'member-1')).toBe(0);
      expect(await countFor('Site', 'id', 'site-shared')).toBe(1);
      expect(await countFor('EnergyDayArchive', 'site_id', 'site-shared')).toBe(1);
      expect(await countFor('EnergyDaySummary', 'site_id', 'site-shared')).toBe(1);
      expect(await countFor('SiteMember', 'site_id', 'site-shared')).toBe(1);
      expect(await countFor('TrmnlInstallation', 'site_id', 'site-shared')).toBe(1);
      const siteRow = (await db.query('SELECT user_id, tesla_connection_user_id FROM "Site" WHERE id = \'site-shared\'')).rows[0];
      expect(siteRow).toEqual({ user_id: null, tesla_connection_user_id: null });

      // Deleting the last remaining member now removes the site and its history.
      const second = await new AccountDeletionRepo().deleteAccount('member-2');
      expect(second).toEqual({ deletedSiteIds: ['site-shared'], survivingSiteIds: [] });
      expect(await countFor('Site', 'id', 'site-shared')).toBe(0);
      expect(await countFor('EnergyDaySummary', 'site_id', 'site-shared')).toBe(0);
    });

    it('allows deleting a member during an active Battery Saver session when another usable member remains on the site', async () => {
      const db = local.database;
      await seedAccount('member-hold-1', 'site-shared-hold');
      await db.query('INSERT INTO "User" (id, refresh_token, auth_status) VALUES (\'member-hold-2\', \'rt-hold-2\', \'active\')');
      await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES (\'site-shared-hold\', \'member-hold-2\', \'tesla-hold-2\')');
      await insertActiveHold('site-shared-hold', 'member-hold-1');

      await expect(new AccountDeletionRepo().deleteAccount('member-hold-1')).resolves.toEqual({
        deletedSiteIds: [],
        survivingSiteIds: ['site-shared-hold'],
      });
      expect(await countFor('BatteryHold', 'site_id', 'site-shared-hold')).toBe(1);
      await db.query('DELETE FROM "BatteryHold" WHERE site_id = \'site-shared-hold\'');
      await new AccountDeletionRepo().deleteAccount('member-hold-2');
    });

    it('refuses while Battery Saver is active with no other usable member and rolls everything back', async () => {
      await seedAccount('holding', 'site-c');
      await insertActiveHold('site-c', 'holding');

      await expect(new AccountDeletionRepo().deleteAccount('holding')).rejects.toBeInstanceOf(ActiveBatterySaverError);

      expect(await countFor('User', 'id', 'holding')).toBe(1);
      expect(await countFor('EnergyDayArchive', 'site_id', 'site-c')).toBe(1);
    });

    it('refuses while a Battery Saver start claim is held on a sole-member site', async () => {
      await local.database.query('DELETE FROM "BatteryHold" WHERE site_id = \'site-c\'');
      await local.database.query(
        `INSERT INTO "BatteryHoldStartClaim" (claim_key, owner, expires_at) VALUES ('hw-site-c', $1::uuid, clock_timestamp() + interval '1 minute')`,
        [randomUUID()],
      );

      await expect(new AccountDeletionRepo().deleteAccount('holding')).rejects.toBeInstanceOf(ActiveBatterySaverError);
      expect(await countFor('User', 'id', 'holding')).toBe(1);
      expect(await countFor('Site', 'id', 'site-c')).toBe(1);
    });

    it('refuses while a start claim is held on a shared site whose other member cannot restore', async () => {
      const db = local.database;
      await seedAccount('claimer', 'site-claim');
      await db.query('INSERT INTO "User" (id, refresh_token, auth_status) VALUES (\'unusable\', NULL, \'revoked\')');
      await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES (\'site-claim\', \'unusable\', \'tesla-claim-2\')');
      await db.query(
        `INSERT INTO "BatteryHoldStartClaim" (claim_key, owner, expires_at) VALUES ('hw-site-claim', $1::uuid, clock_timestamp() + interval '1 minute')`,
        [randomUUID()],
      );

      await expect(new AccountDeletionRepo().deleteAccount('claimer')).rejects.toBeInstanceOf(ActiveBatterySaverError);
      expect(await countFor('User', 'id', 'claimer')).toBe(1);
    });

    it('deletes a shared site for every member when chosen, keeping the other accounts and their other sites', async () => {
      const db = local.database;
      await seedAccount('owner', 'site-everyone', 'Shared');
      await seedAccount('other', 'site-other-own', 'Other Own');
      await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES (\'site-everyone\', \'other\', \'tesla-everyone-2\')');
      await db.query('INSERT INTO "TrmnlInstallation" (site_id, installed_by_user_id) VALUES (\'site-everyone\', \'other\')');
      await insertActiveHold('site-everyone', 'owner');
      await db.query('DELETE FROM "BatteryHold" WHERE site_id = \'site-everyone\'');

      const result = await new AccountDeletionRepo().deleteAccount('owner', ['site-everyone', 'not-mine']);

      expect(result).toEqual({ deletedSiteIds: ['site-everyone'], survivingSiteIds: [] });
      expect(await countFor('Site', 'id', 'site-everyone')).toBe(0);
      expect(await countFor('SiteMember', 'site_id', 'site-everyone')).toBe(0);
      expect(await countFor('TrmnlInstallation', 'site_id', 'site-everyone')).toBe(0);
      expect(await countFor('EnergyDaySummary', 'site_id', 'site-everyone')).toBe(0);
      expect(await countFor('User', 'id', 'other')).toBe(1);
      expect(await countFor('Site', 'id', 'site-other-own')).toBe(1);
    });

    it('refuses to delete a shared site for everyone while Battery Saver is active, even with another usable member', async () => {
      const db = local.database;
      await seedAccount('o2', 'site-everyone-hold');
      await db.query('INSERT INTO "User" (id, refresh_token, auth_status) VALUES (\'m2\', \'rt-m2\', \'active\')');
      await db.query('INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES (\'site-everyone-hold\', \'m2\', \'tesla-m2\')');
      await insertActiveHold('site-everyone-hold', 'o2');

      await expect(new AccountDeletionRepo().deleteAccount('o2', ['site-everyone-hold'])).rejects.toBeInstanceOf(ActiveBatterySaverError);
      expect(await countFor('Site', 'id', 'site-everyone-hold')).toBe(1);
      expect(await countFor('SiteMember', 'site_id', 'site-everyone-hold')).toBe(2);
    });

    it('finishes without error when the account is already gone', async () => {
      await expect(new AccountDeletionRepo().deleteAccount('missing')).resolves.toEqual({
        deletedSiteIds: [],
        survivingSiteIds: [],
      });
    });
  });
});
