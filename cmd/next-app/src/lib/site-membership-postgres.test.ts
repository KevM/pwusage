import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const local = vi.hoisted(() => ({ database: undefined as unknown as Pool }));
vi.mock('./db', () => ({ pool: {
  query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
  connect: () => local.database.connect(),
} }));
import { BatteryHoldRepo } from './battery-hold-repo';
import { BatteryHoldActivityRepo } from './battery-hold-activity-repo';
import { SiteRepo } from './site-repo';
import { UserRepo } from './user-repo';
import { SiteMembershipJoinRepo } from './site-membership-join-repo';
import { mergeEmptyDuplicateSite } from './site-merge';
import type { EnergySiteInfo } from './tesla-client';

const socket = process.env.SITE_MEMBERSHIP_TEST_SOCKET;
const safeSocket = socket && /^\/(?:private\/)?tmp\/site-membership-pg-[a-zA-Z0-9]+$/.test(socket);
if (socket && !safeSocket) throw new Error('Site membership tests require a disposable local socket');

const migration = 'db-migrations/20261108203927_add_site_member.sql';

describe.skipIf(!safeSocket)('Site membership PostgreSQL schema and claims', () => {
  const repo = new BatteryHoldRepo();
  let backfill: { tesla_hardware_id: string; tesla_connection_user_id: string; tesla_energy_site_id: string };

  beforeAll(async () => {
    local.database = new Pool({ host: socket, port: 55453, user: process.env.USER, database: 'postgres', max: 5 });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await local.database.query(`CREATE ROLE ${role}`);
    }
    await local.database.query(`CREATE TABLE "User" (
      id text PRIMARY KEY, is_active boolean DEFAULT true, access_token text, refresh_token text,
      auth_status text, tesla_refresh_state text DEFAULT 'ready', fleet_api_base_url text,
      refresh_lock_expires bigint, tesla_refresh_retry_after bigint,
      auth_lost_at timestamptz, auth_restored_at timestamptz,
      roles text[] NOT NULL DEFAULT '{}'::text[]
    )`);
    await local.database.query(`CREATE TABLE "Site" (
      id text PRIMARY KEY, user_id text REFERENCES "User"(id), json jsonb,
      last_live_refresh_at bigint, name text NOT NULL DEFAULT 'Home',
      installed timestamptz NOT NULL DEFAULT now(), timezone text NOT NULL DEFAULT 'UTC'
    )`);
    await local.database.query(`CREATE TABLE "TrmnlInstallation" (
      id bigserial PRIMARY KEY, site_id text REFERENCES "Site"(id)
    )`);
    // Minimal stand-ins: the merge only counts rows, and a bare delete of a site with summaries must fail.
    await local.database.query(`CREATE TABLE "EnergyDayArchive" (id bigserial PRIMARY KEY,
      site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE)`);
    await local.database.query(`CREATE TABLE "EnergyDaySummary" (id bigserial PRIMARY KEY,
      site_id text NOT NULL REFERENCES "Site"(id))`);
    await local.database.query(`CREATE TABLE "LoadTag" (id bigserial PRIMARY KEY,
      site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE)`);
    for (const file of [
      '20260525000000_add_battery_hold.sql',
      '20260525010000_battery_hold_enhancements.sql',
      '20260525020000_add_cancelled_observed_reserve.sql',
      '20261014133344_battery_hold_monitor_claim.sql',
      '20261015110716_battery_hold_activities.sql',
      '20261015124139_battery_hold_activity_ended_token.sql',
    ]) await local.database.query(await readFile(`db-migrations/${file}`, 'utf8'));
    await local.database.query(`INSERT INTO "User" (id, refresh_token) VALUES ('u1', 'r1')`);
    await local.database.query(`INSERT INTO "Site" (id, user_id, json) VALUES ('s1', 'u1', '{"id":"hardware-1"}')`);
    const sql = await readFile(migration, 'utf8');
    await local.database.query(sql);
    await local.database.query(sql);
    backfill = (await local.database.query(`SELECT s.tesla_hardware_id, s.tesla_connection_user_id,
      m.tesla_energy_site_id FROM "Site" s JOIN "SiteMember" m ON m.site_id=s.id WHERE s.id='s1'`)).rows[0];
  });
  afterAll(async () => { await local.database?.end(); });
  beforeEach(async () => {
    await local.database.query(`TRUNCATE "BatteryHoldStartClaim", "BatteryHoldActivity", "BatteryHold", "TrmnlInstallation", "SiteMember", "Site", "User" CASCADE`);
    await local.database.query(`INSERT INTO "User" (id, refresh_token) VALUES ('u1', 'r1'), ('u2', 'r2')`);
    await local.database.query(`INSERT INTO "Site" (id, user_id, json, tesla_hardware_id) VALUES
      ('s1', 'u1', '{"id":"hardware-1"}', 'hardware-1'),
      ('s2', 'u2', '{"id":"hardware-1"}', 'hardware-1')`);
    await local.database.query(`INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
      VALUES ('s1', 'u1', 's1'), ('s2', 'u2', 's2')`);
    await local.database.query(`UPDATE "Site" SET tesla_connection_user_id=user_id`);
  });

  it('backfills hardware and the original Tesla ID and reruns safely', () => {
    expect(backfill).toEqual({ tesla_hardware_id: 'hardware-1', tesla_connection_user_id: 'u1', tesla_energy_site_id: 's1' });
  });

  it('requires the connection to be a member and clears it on removal', async () => {
    await expect(local.database.query(`UPDATE "Site" SET tesla_connection_user_id='u2' WHERE id='s1'`)).rejects.toThrow();
    await local.database.query(`DELETE FROM "SiteMember" WHERE site_id='s1' AND user_id='u1'`);
    const row = (await local.database.query(`SELECT tesla_connection_user_id FROM "Site" WHERE id='s1'`)).rows[0];
    expect(row.tesla_connection_user_id).toBeNull();
  });

  it('mirrors assignment and removes only IDs absent from a newer successful product list', async () => {
    const sites = new SiteRepo();
    const oldListFetchedAt = new Date(Date.now() - 60_000);
    await sites.assignSiteToUser('s1', 'u1');
    expect(await sites.removeSitesMissingFromTesla('u1', [], oldListFetchedAt)).toEqual([]);
    expect(await sites.removeSitesMissingFromTesla('u1', ['s1'], new Date(Date.now() + 1000))).toEqual([]);
    expect(await sites.removeSitesMissingFromTesla('u1', [], new Date(Date.now() + 1000))).toEqual(['s1']);
    const row = (await local.database.query(`SELECT user_id, tesla_connection_user_id FROM "Site" WHERE id='s1'`)).rows[0];
    expect(row).toEqual({ user_id: null, tesla_connection_user_id: null });
  });

  it('loads the connection grant and the pinned member’s current Tesla ID together', async () => {
    const users = new UserRepo();
    const sites = new SiteRepo();
    const first = await users.getTokensForSite('s1');
    expect(first?.user_id).toBe('u1');
    expect(first?.tesla_energy_site_id).toBe('s1');
    await local.database.query(`UPDATE "SiteMember" SET tesla_energy_site_id='reinvite-1' WHERE site_id='s1'`);
    expect((await users.getTokensForSiteMember('s1', 'u1'))?.tesla_energy_site_id).toBe('reinvite-1');
    expect((await users.getTokensForSite('s1'))?.tesla_energy_site_id).toBe('reinvite-1');
    expect(await sites.getSiteIdsForTeslaIds(['reinvite-1'])).toEqual(['s1']);
    expect(await sites.getSiteIdsForTeslaIds(['s1'])).toEqual([]);
  });

  it('authorizes every shared-site member, but not an unrelated account', async () => {
    const activities = new BatteryHoldActivityRepo();
    await local.database.query(`INSERT INTO "User" (id, refresh_token) VALUES ('u3', 'r3')`);
    await local.database.query(`INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
      VALUES ('s1', 'u2', 'invited-id')`);
    vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
    try {
      await expect(activities.userCanAccessSite('u2', 's1')).resolves.toBe(true);
      await expect(activities.userCanAccessSite('u3', 's1')).resolves.toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('moves a broken connection to a usable member and leaves a healthy connection alone', async () => {
    const sites = new SiteRepo();
    await local.database.query(`INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
      VALUES ('s1', 'u2', 'invited-id')`);
    vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
    try {
      expect(await sites.repairConnection('s1')).toBeNull();
      await local.database.query(`UPDATE "User" SET auth_status='revoked', auth_lost_at=now()-interval '1 hour' WHERE id='u1'`);
      expect(await sites.repairConnection('s1')).toBe('u2');
      const row = (await local.database.query(`SELECT user_id, tesla_connection_user_id,
        connection_lost_at, connection_restored_at FROM "Site" WHERE id='s1'`)).rows[0];
      expect(row.user_id).toBe('u2');
      expect(row.tesla_connection_user_id).toBe('u2');
      expect(row.connection_lost_at).toBeInstanceOf(Date);
      expect(row.connection_restored_at).toBeInstanceOf(Date);
      expect(await new UserRepo().getAuthRestoredAtForSite('s1')).toEqual(row.connection_restored_at);
      expect(await sites.repairConnection('s1')).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('repairs all broken sites independently and converts a millisecond live stamp', async () => {
    const sites = new SiteRepo();
    const liveAt = Date.now() - 60_000;
    await local.database.query(`INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
      VALUES ('s1', 'u2', 'invited-id')`);
    await local.database.query(`UPDATE "Site" SET last_live_refresh_at=$1 WHERE id='s1'`, [liveAt]);
    await local.database.query(`UPDATE "User" SET auth_status='revoked' WHERE id='u1'`);
    vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
    try {
      expect(await sites.repairAllConnections()).toBe(1);
      const rows = (await local.database.query(`SELECT id, tesla_connection_user_id, connection_lost_at FROM "Site" ORDER BY id`)).rows;
      expect(rows[0].tesla_connection_user_id).toBe('u2');
      expect(rows[0].connection_lost_at.getTime()).toBeCloseTo(liveAt, -2);
      expect(rows[1].tesla_connection_user_id).toBe('u2');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('removes only an older missing mapping and clears the departing member’s devices', async () => {
    const sites = new SiteRepo();
    const stale = new Date(Date.now() - 60_000);
    const current = new Date(Date.now() + 60_000);
    await local.database.query(`INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
      VALUES ('s1', 'u2', 'invited-id')`);
    const hold = await repo.createHold({ siteId: 's1', originalReserve: 20, targetReserve: 100,
      parkedSoc: 80, baselineLoadW: 500, safetyExpiresAt: current });
    await local.database.query(`INSERT INTO "BatteryHoldActivity"
      (hold_id, user_id, registration_id, push_token, apns_environment, expires_at)
      VALUES ($1, 'u1', $2, 'push-token', 'sandbox', $3)`, [hold.id, randomUUID(), current]);
    await local.database.query(`INSERT INTO "TrmnlInstallation" (site_id, installed_by_user_id)
      VALUES ('s1', 'u1')`);
    vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
    try {
      expect(await sites.removeMemberIfMissing('s1', 'u1', 's1', stale)).toBe(false);
      expect(await sites.touchMember('s1', 'u1', 's1', current)).toBe(true);
      expect(await sites.removeMemberIfMissing('s1', 'u1', 's1', new Date(Date.now() + 120_000))).toBe(true);
      expect(await sites.removeMemberIfMissing('s1', 'u1', 's1', new Date(Date.now() + 180_000))).toBe(false);
      const members = (await local.database.query(`SELECT user_id FROM "SiteMember" WHERE site_id='s1'`)).rows;
      expect(members.map(row => row.user_id)).toEqual(['u2']);
      const activity = (await local.database.query(`SELECT delivery_state, push_token FROM "BatteryHoldActivity"`)).rows[0];
      expect(activity).toEqual({ delivery_state: 'disabled', push_token: null });
      expect((await local.database.query(`SELECT count(*)::int AS n FROM "TrmnlInstallation"`)).rows[0].n).toBe(0);
      expect((await local.database.query(`SELECT status FROM "BatteryHold" WHERE id=$1`, [hold.id])).rows[0].status).toBe('active');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ends an active hold when the last member leaves without sending a command', async () => {
    const sites = new SiteRepo();
    const hold = await repo.createHold({ siteId: 's1', originalReserve: 20, targetReserve: 100,
      parkedSoc: 80, baselineLoadW: 500, safetyExpiresAt: new Date(Date.now() + 60_000) });
    vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
    try {
      expect(await sites.removeMemberIfMissing('s1', 'u1', 's1', new Date(Date.now() + 60_000))).toBe(true);
      const row = (await local.database.query(`SELECT status, restore_reason FROM "BatteryHold" WHERE id=$1`, [hold.id])).rows[0];
      expect(row).toEqual({ status: 'cancelled', restore_reason: 'no_members' });
      expect((await local.database.query(`SELECT id FROM "Site" WHERE id='s1'`)).rows).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps a sole dead member but removes one after another member is seen alive', async () => {
    const sites = new SiteRepo();
    await local.database.query(`UPDATE "User" SET auth_status='revoked',
      auth_lost_at=now()-interval '15 days' WHERE id='u1'`);
    await local.database.query(`UPDATE "SiteMember" SET last_seen_in_tesla_at=now()-interval '15 days'
      WHERE site_id='s1' AND user_id='u1'`);
    vi.stubEnv('SITE_MEMBERSHIP_ENABLED', 'true');
    try {
      expect(await sites.removeDeadMember('s1', 'u1', 's1')).toBe(false);
      await local.database.query(`INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
        VALUES ('s1', 'u2', 'invited-id')`);
      expect(await sites.removeDeadMember('s1', 'u1', 's1')).toBe(true);
      expect((await local.database.query(`SELECT user_id, tesla_connection_user_id FROM "Site" WHERE id='s1'`)).rows[0])
        .toEqual({ user_id: 'u2', tesla_connection_user_id: 'u2' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('joins a verified home, updates a re-invite, and retries when the checked set changes', async () => {
    const joins = new SiteMembershipJoinRepo();
    await local.database.query(`INSERT INTO "User" (id, refresh_token) VALUES ('u3', 'r3'), ('u4', 'r4')`);
    const info = { id: 'hardware-1', site_name: 'Home' } as EnergySiteInfo;
    const fetchedAt = new Date();
    const observed = await joins.membersForHardware('hardware-1');
    const joined = await joins.commitDecision({ userId: 'u3', teslaId: 'invited-id', info,
      hardwareId: 'hardware-1', observedMembers: observed, verifiedSiteId: 's1', fetchedAt });
    expect(joined).toEqual({ kind: 'joined', siteId: 's1' });
    expect((await joins.membersForUser('u3')).find(member => member.site_id === 's1')?.tesla_energy_site_id).toBe('invited-id');
    const reinvite = await joins.commitDecision({ userId: 'u3', teslaId: 'new-invite-id', info,
      hardwareId: 'hardware-1', observedMembers: observed, verifiedSiteId: null, fetchedAt });
    expect(reinvite).toEqual({ kind: 'reinvite', siteId: 's1' });
    expect((await joins.membersForUser('u3')).find(member => member.site_id === 's1')?.tesla_energy_site_id).toBe('new-invite-id');

    const stale = await joins.commitDecision({ userId: 'u4', teslaId: 'third-id', info,
      hardwareId: 'hardware-1', observedMembers: observed, verifiedSiteId: 's1', fetchedAt });
    expect(stale).toEqual({ kind: 'retry' });
    expect((await local.database.query(`SELECT count(*)::int AS n FROM "SiteMember" WHERE user_id='u4'`)).rows[0].n).toBe(0);
  });

  it('creates a fresh site and mapping under the hardware lock', async () => {
    const joins = new SiteMembershipJoinRepo();
    const info = { id: 'new-hardware', site_name: 'New Home', installation_time_zone: 'America/Chicago' } as EnergySiteInfo;
    const result = await joins.commitDecision({ userId: 'u1', teslaId: 'new-tesla-id', info,
      hardwareId: 'new-hardware', observedMembers: [], verifiedSiteId: null, fetchedAt: new Date() });
    expect(result).toEqual({ kind: 'fresh', siteId: 'new-tesla-id' });
    const row = (await local.database.query(`SELECT s.user_id, s.tesla_connection_user_id,
      s.tesla_hardware_id, s.json, m.tesla_energy_site_id FROM "Site" s
      JOIN "SiteMember" m ON m.site_id=s.id WHERE s.id='new-tesla-id'`)).rows[0];
    expect(row).toEqual({ user_id: 'u1', tesla_connection_user_id: 'u1',
      tesla_hardware_id: 'new-hardware', json: {}, tesla_energy_site_id: 'new-tesla-id' });
  });

  it('lets only one worker claim hardware shared by duplicate rows', async () => {
    expect(await repo.getStartClaimKey('s1')).toBe('hardware-1');
    expect(await repo.getStartClaimKey('s2')).toBe('hardware-1');
    const owners = Array.from({ length: 8 }, () => randomUUID());
    const wins = await Promise.all(owners.map(owner => repo.claimStart('hardware-1', owner)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    const winner = owners[wins.findIndex(Boolean)];
    const next = randomUUID();
    await local.database.query(`UPDATE "BatteryHoldStartClaim" SET expires_at=now()-interval '1 second'`);
    expect(await repo.claimStart('hardware-1', next)).toBe(true);
    await repo.releaseStart('hardware-1', winner);
    expect(await repo.claimStart('hardware-1', randomUUID())).toBe(false);
    await repo.releaseStart('hardware-1', next);
  });

  it('finds an active hold on another row and retires it only when no usable member remains', async () => {
    const hold = await repo.createHold({ siteId: 's2', originalReserve: 20, targetReserve: 100,
      parkedSoc: 80, baselineLoadW: 500, safetyExpiresAt: new Date(Date.now() - 60_000) });
    expect((await repo.getActiveHoldForClaim('hardware-1'))?.id).toBe(hold.id);
    expect(await repo.retireUnrestorableHold(hold.id)).toBe(false);
    await local.database.query(`UPDATE "User" SET auth_status='revoked' WHERE id='u2'`);
    expect(await repo.retireUnrestorableHold(hold.id)).toBe(true);
    expect((await repo.getActiveHoldForClaim('hardware-1'))).toBeNull();
    const row = (await local.database.query(`SELECT status, restore_reason FROM "BatteryHold" WHERE id=$1`, [hold.id])).rows[0];
    expect(row).toEqual({ status: 'cancelled', restore_reason: 'no_usable_members' });
  });

  it('stores the starter and command-permission state on their member row', async () => {
    const hold = await repo.createHold({ siteId: 's1', originalReserve: 20, targetReserve: 100,
      parkedSoc: 80, baselineLoadW: 500, safetyExpiresAt: new Date(Date.now() + 60_000),
      startedByUserId: 'u1' });
    expect(hold.started_by_user_id).toBe('u1');
    await repo.markCommandsDenied('s1', 'u1');
    expect((await local.database.query(`SELECT commands_denied_at FROM "SiteMember" WHERE site_id='s1'`)).rows[0].commands_denied_at).toBeInstanceOf(Date);
    await repo.clearCommandsDenied('s1', 'u1');
    expect((await local.database.query(`SELECT commands_denied_at FROM "SiteMember" WHERE site_id='s1'`)).rows[0].commands_denied_at).toBeNull();
  });

  it('orders usable restore grants, moving recently denied members to the end', async () => {
    await local.database.query(`INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id)
      VALUES ('s1', 'u2', 'invited-id')`);
    const hold = await repo.createHold({ siteId: 's1', originalReserve: 20, targetReserve: 100,
      parkedSoc: 80, baselineLoadW: 500, safetyExpiresAt: new Date(Date.now() + 60_000),
      startedByUserId: 'u2' });
    expect(await repo.getRestoreCandidates(hold.id)).toEqual(['u2', 'u1']);
    expect(await repo.getRestoreCandidates(hold.id, 'u1')).toEqual(['u1', 'u2']);
    await repo.markCommandsDenied('s1', 'u2');
    expect(await repo.getRestoreCandidates(hold.id)).toEqual(['u1', 'u2']);
    await local.database.query(`UPDATE "User" SET auth_status='revoked' WHERE id='u1'`);
    expect(await repo.getRestoreCandidates(hold.id)).toEqual(['u2']);
  });

  describe('merging an empty duplicate site into the real one', () => {
    const members = async (siteId: string) => (await local.database.query(
      `SELECT user_id, tesla_energy_site_id FROM "SiteMember" WHERE site_id=$1 ORDER BY user_id`, [siteId])).rows;
    const siteExists = async (id: string) => (await local.database.query(`SELECT 1 FROM "Site" WHERE id=$1`, [id])).rowCount === 1;

    it('dry run reports the move and writes nothing', async () => {
      const result = await mergeEmptyDuplicateSite({ primaryId: 's1', secondaryId: 's2', apply: false });
      expect(result).toEqual({ applied: false, blockers: [], movedMembers: [{ userId: 'u2', teslaEnergySiteId: 's2' }] });
      expect(await siteExists('s2')).toBe(true);
      expect(await members('s1')).toEqual([{ user_id: 'u1', tesla_energy_site_id: 's1' }]);
    });

    it('moves the member with their own Tesla ID, deletes the duplicate and leaves the connection alone', async () => {
      const result = await mergeEmptyDuplicateSite({ primaryId: 's1', secondaryId: 's2', apply: true });
      expect(result.applied).toBe(true);
      expect(await siteExists('s2')).toBe(false);
      expect(await members('s1')).toEqual([
        { user_id: 'u1', tesla_energy_site_id: 's1' }, { user_id: 'u2', tesla_energy_site_id: 's2' }]);
      expect((await local.database.query(`SELECT tesla_connection_user_id FROM "Site" WHERE id='s1'`)).rows[0].tesla_connection_user_id).toBe('u1');
      expect(await new SiteRepo().getSiteIdsForTeslaIds(['s2'])).toEqual(['s1']);
    });

    it('releases the start claim afterwards and refuses a rerun cleanly', async () => {
      await mergeEmptyDuplicateSite({ primaryId: 's1', secondaryId: 's2', apply: true });
      expect(await repo.claimStart('hardware-1', randomUUID())).toBe(true);
      await local.database.query(`DELETE FROM "BatteryHoldStartClaim"`);
      const rerun = await mergeEmptyDuplicateSite({ primaryId: 's1', secondaryId: 's2', apply: true });
      expect(rerun).toEqual({ applied: false, blockers: ['secondary-not-found'], movedMembers: [] });
    });

    it.each([
      ['archived days', `INSERT INTO "EnergyDayArchive" (site_id) VALUES ('s2')`, 'secondary-has-archived-days'],
      ['summaries', `INSERT INTO "EnergyDaySummary" (site_id) VALUES ('s2')`, 'secondary-has-summaries'],
      ['TRMNL devices', `INSERT INTO "TrmnlInstallation" (site_id) VALUES ('s2')`, 'secondary-has-trmnl-installations'],
      ['tags', `INSERT INTO "LoadTag" (site_id) VALUES ('s2')`, 'secondary-has-tags'],
      ['a different timezone', `UPDATE "Site" SET timezone='America/Chicago' WHERE id='s2'`, 'timezones-differ'],
      ['different hardware', `UPDATE "Site" SET tesla_hardware_id='hardware-2' WHERE id='s2'`, 'hardware-differs'],
      ['a missing hardware ID', `UPDATE "Site" SET tesla_hardware_id=NULL WHERE id IN ('s1','s2')`, 'hardware-differs'],
      ['the same person already on the primary', `INSERT INTO "SiteMember" (site_id, user_id, tesla_energy_site_id) VALUES ('s1','u2','other-id')`, 'member-already-on-primary'],
      ['an active hold on the secondary', `INSERT INTO "BatteryHold" (site_id, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at) VALUES ('s2',20,100,80,500,now()+interval '1 hour')`, 'active-hold'],
      ['an active hold on the primary', `INSERT INTO "BatteryHold" (site_id, original_reserve, target_reserve, parked_soc, baseline_load_w, safety_expires_at) VALUES ('s1',20,100,80,500,now()+interval '1 hour')`, 'active-hold'],
      ['a start in progress', `INSERT INTO "BatteryHoldStartClaim" (claim_key, owner, expires_at) VALUES ('hardware-1','${randomUUID()}', now()+interval '1 minute')`, 'start-claim-held'],
    ])('refuses and writes nothing with %s', async (_label, setup, blocker) => {
      await local.database.query(setup);
      const dry = await mergeEmptyDuplicateSite({ primaryId: 's1', secondaryId: 's2', apply: false });
      expect(dry.blockers).toContain(blocker);
      const result = await mergeEmptyDuplicateSite({ primaryId: 's1', secondaryId: 's2', apply: true });
      expect(result.applied).toBe(false);
      expect(result.blockers).toContain(blocker);
      expect(await siteExists('s2')).toBe(true);
      expect((await members('s2')).length).toBe(1);
    });

    it('refuses to merge a site into itself', async () => {
      const result = await mergeEmptyDuplicateSite({ primaryId: 's1', secondaryId: 's1', apply: true });
      expect(result).toEqual({ applied: false, blockers: ['same-site'], movedMembers: [] });
      expect(await siteExists('s1')).toBe(true);
    });
  });
});
