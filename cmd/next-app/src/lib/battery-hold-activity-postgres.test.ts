import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { BatteryHoldMonitoring } from './battery-hold-monitoring';

const local = vi.hoisted(() => ({ database: undefined as unknown as import('pg').Pool }));
vi.mock('./db', () => ({ pool: { query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args) } }));
import { BatteryHoldRepo } from './battery-hold-repo';
import {
  BatteryHoldActivityRepo, reconcileBatteryHoldActivities, type ActivityRegistration,
} from './battery-hold-activity-repo';
import { restoreBattery } from './battery-hold-service';
import { monitorBatteryHolds } from './battery-hold-monitor-service';
import type { TeslaClient } from './tesla-client';

const socket = process.env.BATTERY_HOLD_TEST_SOCKET;
const safeSocket = socket && /^\/(?:private\/)?tmp\/battery-hold-pg-[a-zA-Z0-9]+$/.test(socket);
if (socket && !safeSocket) throw new Error('Battery hold tests require a disposable private local socket');

const T1 = '2026-10-15T10:00:00.000Z';
const T2 = '2026-10-15T10:15:00.000Z';
const monitoring = (checked_at: string): BatteryHoldMonitoring => ({
  phase: 'watching', checked_at, next_check_at: '2026-10-15T10:30:00.000Z', sampled_at: null, estimated_load_w: null,
});

describe.skipIf(!safeSocket)('BatteryHoldActivity isolated PostgreSQL', () => {
  let repo: BatteryHoldActivityRepo;
  let holdRepo: BatteryHoldRepo;
  let holdId: number;

  const rows = async () => (await local.database.query('SELECT * FROM "BatteryHoldActivity" ORDER BY id')).rows;
  const registration = (overrides: Partial<ActivityRegistration> = {}): ActivityRegistration => ({
    holdId, userId: 'u1', registrationId: randomUUID(), pushToken: 'a'.repeat(64), apnsEnvironment: 'sandbox', ...overrides,
  });
  const insertRaw = (values: { delivery_state?: string; push_token?: string | null; apns_environment?: string }) =>
    local.database.query(`INSERT INTO "BatteryHoldActivity"
      (hold_id, user_id, registration_id, push_token, apns_environment, delivery_state, expires_at)
      VALUES ($1, 'u1', $2::uuid, $3, $4, $5, now() + interval '1 hour')`,
    [holdId, randomUUID(), values.push_token === undefined ? 'a'.repeat(64) : values.push_token,
      values.apns_environment ?? 'sandbox', values.delivery_state ?? 'pending']);

  beforeAll(async () => {
    const admin = new Pool({ host: socket, port: 55440, user: process.env.USER, database: 'postgres', max: 1 });
    await admin.query('DROP DATABASE IF EXISTS battery_hold_activity_test');
    await admin.query('CREATE DATABASE battery_hold_activity_test');
    await admin.end();
    local.database = new Pool({ host: socket, port: 55440, user: process.env.USER, database: 'battery_hold_activity_test', max: 5 });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await local.database.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    }
    await local.database.query(`CREATE TABLE "User" (id text PRIMARY KEY, is_active boolean DEFAULT true, roles text[])`);
    await local.database.query(`CREATE TABLE "Site" (id text PRIMARY KEY, user_id text REFERENCES "User"(id))`);
    for (const migration of [
      '20260525000000_add_battery_hold.sql', '20260525010000_battery_hold_enhancements.sql',
      '20260525020000_add_cancelled_observed_reserve.sql', '20260701114315_enable_battery_hold_rls.sql',
      '20261002135116_battery_hold_monitoring.sql', '20261014133344_battery_hold_monitor_claim.sql',
    ]) {
      await local.database.query(await readFile(`db-migrations/${migration}`, 'utf8'));
    }
    const [activityMigration] = (await readdir('db-migrations')).filter(f => f.endsWith('_battery_hold_activities.sql'));
    const sql = await readFile(`db-migrations/${activityMigration}`, 'utf8');
    await local.database.query(sql);
    await local.database.query(sql);
    repo = new BatteryHoldActivityRepo();
    holdRepo = new BatteryHoldRepo();
  });

  afterAll(async () => { await local.database?.end(); });

  beforeEach(async () => {
    await local.database.query('TRUNCATE "BatteryHoldActivity", "BatteryHold", "Site", "User" CASCADE');
    await local.database.query(`INSERT INTO "User" (id, roles) VALUES ('u1', '{}'), ('u2', '{}'), ('admin', '{admin}')`);
    await local.database.query(`INSERT INTO "Site" (id, user_id) VALUES ('s1', 'u1'), ('s2', 'u2')`);
    holdId = (await holdRepo.createHold({
      siteId: 's1', originalReserve: 20, targetReserve: 100, parkedSoc: 90, baselineLoadW: 500, safetyExpiresAt: new Date(),
    })).id;
  });

  it('migration enables RLS, revokes client roles, grants service_role, and enforces checks', async () => {
    const { rows: [rls] } = await local.database.query(`SELECT relrowsecurity FROM pg_class WHERE oid = '"BatteryHoldActivity"'::regclass`);
    expect(rls.relrowsecurity).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      expect((await local.database.query(`SELECT has_table_privilege($1, '"BatteryHoldActivity"', 'SELECT') AS ok`, [role])).rows[0].ok).toBe(false);
    }
    for (const privilege of ['SELECT', 'INSERT']) {
      expect((await local.database.query(`SELECT has_table_privilege('service_role', '"BatteryHoldActivity"', $1) AS ok`, [privilege])).rows[0].ok).toBe(true);
    }
    expect((await local.database.query(`SELECT has_sequence_privilege('service_role', '"BatteryHoldActivity_id_seq"', 'USAGE') AS ok`)).rows[0].ok).toBe(true);
    await expect(insertRaw({ apns_environment: 'staging' })).rejects.toThrow(/check constraint/);
    await expect(insertRaw({ delivery_state: 'bogus' })).rejects.toThrow(/check constraint/);
    await expect(insertRaw({ push_token: null })).rejects.toThrow(/check constraint/);
    await expect(insertRaw({ push_token: null, delivery_state: 'disabled' })).resolves.toBeDefined();
  });

  it('userCanAccessSite follows current ownership, admin role, and active status', async () => {
    expect(await repo.userCanAccessSite('u1', 's1')).toBe(true);
    expect(await repo.userCanAccessSite('u2', 's1')).toBe(false);
    expect(await repo.userCanAccessSite('admin', 's1')).toBe(true);
    await local.database.query(`UPDATE "User" SET is_active = false WHERE id = 'u1'`);
    expect(await repo.userCanAccessSite('u1', 's1')).toBe(false);
    await local.database.query(`UPDATE "User" SET is_active = true WHERE id = 'u1'`);
    await local.database.query(`UPDATE "Site" SET user_id = 'u2' WHERE id = 's1'`);
    expect(await repo.userCanAccessSite('u1', 's1')).toBe(false);
  });

  it('getHoldForSite returns the hold only for its own site', async () => {
    expect(await repo.getHoldForSite(holdId, 's1')).toMatchObject({ id: holdId, status: 'active', restored_at: null });
    expect(await repo.getHoldForSite(holdId, 's2')).toBeNull();
    expect(await repo.getHoldForSite(999999, 's1')).toBeNull();
  });

  it('registration is idempotent per registration id and rotates the token', async () => {
    const registrationId = randomUUID();
    expect(await repo.register(registration({ registrationId, pushToken: 'a'.repeat(64) }))).toBe('pending');
    expect(await repo.register(registration({ registrationId, pushToken: 'b'.repeat(64) }))).toBe('pending');
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].push_token).toBe('b'.repeat(64));
    await repo.syncDesired(holdId);
    expect(await repo.register(registration({ registrationId, pushToken: 'c'.repeat(64) }))).toBe('pending');
    const [row] = await rows();
    expect(row.push_token).toBe('c'.repeat(64));
    expect(row.desired_version).toBe(1);
  });

  it('keeps one row per device for the same hold', async () => {
    await repo.register(registration());
    await repo.register(registration());
    expect(await repo.syncDesired(holdId)).toBe(2);
    for (const row of await rows()) {
      expect(row.desired_version).toBe(1);
      expect(row.desired_snapshot.status).toBe('active');
      expect(row.desired_snapshot.hold_id).toBe(holdId);
    }
  });

  it('rejects re-registration to another hold or APNs environment and leaves the row unchanged', async () => {
    const registrationId = randomUUID();
    await repo.register(registration({ registrationId, pushToken: 'a'.repeat(64) }));
    const before = (await rows())[0];
    await holdRepo.markRestored(holdId, 'manual');
    const secondHold = await holdRepo.createHold({
      siteId: 's1', originalReserve: 20, targetReserve: 100, parkedSoc: 90, baselineLoadW: 500, safetyExpiresAt: new Date(),
    });
    expect(await repo.register(registration({ holdId: secondHold.id, registrationId, pushToken: 'b'.repeat(64) }))).toBeNull();
    expect(await repo.register(registration({ registrationId, pushToken: 'b'.repeat(64), apnsEnvironment: 'production' }))).toBeNull();
    const [after] = await rows();
    expect(after.hold_id).toBe(before.hold_id);
    expect(after.push_token).toBe(before.push_token);
  });

  it('a registration that arrives after completion starts with the terminal snapshot', async () => {
    await holdRepo.markRestored(holdId, 'manual');
    await repo.register(registration());
    await repo.syncDesired(holdId);
    const [row] = await rows();
    expect(row.desired_snapshot.status).toBe('restored');
    expect(row.desired_snapshot.restored_at).not.toBeNull();
    expect(row.delivery_state).toBe('pending');
    expect(row.desired_version).toBe(1);
  });

  it('completion after registration advances the desired snapshot to restored', async () => {
    await repo.register(registration());
    await repo.syncDesired(holdId);
    await holdRepo.markRestored(holdId, 'manual');
    await repo.syncDesired(holdId);
    const [row] = await rows();
    expect(row.desired_version).toBe(2);
    expect(row.desired_snapshot.status).toBe('restored');
  });

  it('a newer desired version stays pending until its own acknowledgement', async () => {
    await repo.register(registration());
    await repo.syncDesired(holdId);
    let [row] = await rows();
    const id = Number(row.id);
    await repo.acknowledgeDelivery(id, 1);
    expect((await rows())[0].delivery_state).toBe('current');
    await holdRepo.recordMonitoring(holdId, monitoring(T1));
    expect(await repo.syncDesired(holdId)).toBe(1);
    expect((await rows())[0]).toMatchObject({ delivery_state: 'pending', desired_version: 2 });
    await repo.acknowledgeDelivery(id, 1);
    [row] = await rows();
    expect(row).toMatchObject({ delivery_state: 'pending', delivered_version: 1 });
    await repo.acknowledgeDelivery(id, 2);
    [row] = await rows();
    expect(row).toMatchObject({ delivery_state: 'current', delivered_version: 2 });
    expect(await repo.syncDesired(holdId)).toBe(0);
    expect((await rows())[0].desired_version).toBe(2);
    expect(await repo.acknowledgeDelivery(id, 3)).toBe(false);
  });

  it('an older monitoring check never replaces a newer one', async () => {
    await repo.register(registration());
    await holdRepo.recordMonitoring(holdId, monitoring(T2));
    await repo.syncDesired(holdId);
    await local.database.query(`UPDATE "BatteryHold" SET monitoring = $2::jsonb WHERE id = $1`,
      [holdId, JSON.stringify(monitoring(T1))]);
    expect(await repo.syncDesired(holdId)).toBe(0);
    expect((await rows())[0].desired_snapshot.monitoring.checked_at).toBe(T2);
  });

  it('an acknowledged terminal state is never revived or regressed', async () => {
    await repo.register(registration());
    await repo.syncDesired(holdId);
    const id = Number((await rows())[0].id);
    await repo.acknowledgeDelivery(id, 1);
    await holdRepo.markRestored(holdId, 'manual');
    await repo.syncDesired(holdId);
    await repo.acknowledgeDelivery(id, 2);
    expect((await rows())[0].delivery_state).toBe('ended');
    const terminal = (await rows())[0].desired_snapshot;
    expect(await repo.syncDesired(holdId)).toBe(0);
    await repo.acknowledgeDelivery(id, 2);
    await local.database.query(`UPDATE "BatteryHold" SET status = 'active', restored_at = NULL WHERE id = $1`, [holdId]);
    expect(await repo.syncDesired(holdId)).toBe(0);
    const [row] = await rows();
    expect(row.delivery_state).toBe('ended');
    expect(row.desired_snapshot).toEqual(terminal);
    expect(row.desired_version).toBe(2);
  });

  it('an unacknowledged terminal snapshot is not replaced when the hold is reverted to active', async () => {
    await repo.register(registration());
    await repo.syncDesired(holdId);
    await holdRepo.markRestored(holdId, 'manual');
    await repo.syncDesired(holdId);
    await local.database.query(`UPDATE "BatteryHold" SET status = 'active', restored_at = NULL WHERE id = $1`, [holdId]);
    expect(await repo.syncDesired(holdId)).toBe(0);
    const [row] = await rows();
    expect(row.desired_snapshot.status).toBe('restored');
    expect(row.desired_version).toBe(2);
  });

  it('a terminal row survives the active-hold query and is still synced by the no-id reconcile', async () => {
    await repo.register(registration());
    await repo.syncDesired(holdId);
    await holdRepo.markCancelled(holdId, 'reserve_changed', 55);
    expect((await holdRepo.getAllActiveHolds()).map(h => h.id)).not.toContain(holdId);
    expect(await repo.syncDesired()).toBe(1);
    const [row] = await rows();
    expect(row.desired_snapshot.status).toBe('cancelled');
    expect(row.desired_snapshot.cancelled_observed_reserve).toBe(55);
  });

  it('expiry disables rows, clears tokens, and never revives them', async () => {
    const registrationId = randomUUID();
    await repo.register(registration({ registrationId }));
    await repo.syncDesired(holdId);
    await local.database.query(`UPDATE "BatteryHoldActivity" SET expires_at = now() - interval '1 minute'`);
    expect(await repo.expireStale()).toBe(1);
    let [row] = await rows();
    expect(row).toMatchObject({ delivery_state: 'disabled', disabled_reason: 'expired', push_token: null });
    const version = row.desired_version;
    expect(await repo.syncDesired()).toBe(0);
    expect(await repo.register(registration({ registrationId }))).toBe('disabled');
    [row] = await rows();
    expect(row.push_token).toBeNull();
    expect(row.desired_version).toBe(version);
  });

  it('remove deletes only the caller registration on that site', async () => {
    const registrationId = randomUUID();
    await repo.register(registration({ registrationId }));
    expect(await repo.remove('u2', 's1', registrationId)).toBe(false);
    expect(await repo.remove('u1', 's2', registrationId)).toBe(false);
    expect(await rows()).toHaveLength(1);
    expect(await repo.remove('u1', 's1', registrationId)).toBe(true);
    expect(await rows()).toHaveLength(0);
  });

  it('reconcile without an id expires stale rows and syncs live ones in one call', async () => {
    await repo.register(registration());
    await repo.register(registration());
    await local.database.query(`UPDATE "BatteryHoldActivity" SET expires_at = now() - interval '1 minute' WHERE id = (SELECT min(id) FROM "BatteryHoldActivity")`);
    expect(await reconcileBatteryHoldActivities()).toBe(1);
    const all = await rows();
    expect(all[0]).toMatchObject({ delivery_state: 'disabled', push_token: null });
    expect(all[1]).toMatchObject({ delivery_state: 'pending', desired_version: 1 });
  });

  it('a manual stop pushes the restored snapshot to a synced activity', async () => {
    await repo.register(registration());
    await repo.syncDesired(holdId);
    const client = {
      getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }),
      setBackupReserve: vi.fn().mockResolvedValue({ Code: 200 }),
    };
    const result = await restoreBattery({ client: client as unknown as TeslaClient, repo: holdRepo, siteId: 's1', reason: 'manual' });
    expect(result).toEqual({ status: 'ok' });
    expect(client.setBackupReserve).toHaveBeenCalledWith('s1', 20);
    const [row] = await rows();
    expect(row).toMatchObject({ desired_version: 2, delivery_state: 'pending' });
    expect(row.desired_snapshot.status).toBe('restored');
  });

  it('the next monitor run recovers a missed terminal write by reconciling activities', async () => {
    await repo.register(registration());
    await repo.syncDesired(holdId);
    await repo.acknowledgeDelivery(Number((await rows())[0].id), 1);
    expect((await rows())[0].delivery_state).toBe('current');
    await holdRepo.markRestored(holdId, 'manual');
    expect((await rows())[0].desired_version).toBe(1);
    await monitorBatteryHolds([]);
    const [row] = await rows();
    expect(row).toMatchObject({ desired_version: 2, delivery_state: 'pending' });
    expect(row.desired_snapshot.status).toBe('restored');
  });
});
