import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { restoreBattery, type RestoreDeps } from './battery-hold-service';
import { TeslaAuthError } from './tesla-client';

const local = vi.hoisted(() => ({ database: undefined as unknown as import('pg').Pool }));
vi.mock('./db', () => ({ pool: { query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args) } }));
import { BatteryHoldRepo } from './battery-hold-repo';
const socket = process.env.BATTERY_HOLD_TEST_SOCKET;
const safeSocket = socket && /^\/(?:private\/)?tmp\/battery-hold-pg-[a-zA-Z0-9]+$/.test(socket);
if (socket && !safeSocket) throw new Error('Battery hold tests require a disposable private local socket');
describe.skipIf(!safeSocket)('BatteryHold isolated PostgreSQL claims', () => {
  let repo: BatteryHoldRepo;
  let id: number;
  beforeAll(async () => {
    local.database = new Pool({ host: socket, port: 55440, user: process.env.USER, database: 'postgres', max: 5 });
    await local.database.query('CREATE TABLE "Site" (id text PRIMARY KEY)');
    for (const migration of ['20260525000000_add_battery_hold.sql', '20260525010000_battery_hold_enhancements.sql', '20260525020000_add_cancelled_observed_reserve.sql', '20261002135116_battery_hold_monitoring.sql', '20261014133344_battery_hold_monitor_claim.sql']) {
      await local.database.query(await readFile(`db-migrations/${migration}`, 'utf8'));
    }
    repo = new BatteryHoldRepo();
  });
  afterAll(async () => { await local.database?.end(); });
  beforeEach(async () => {
    await local.database.query('TRUNCATE "BatteryHold", "Site" CASCADE');
    await local.database.query(`INSERT INTO "Site" VALUES ('s')`);
    id = (await repo.createHold({ siteId: 's', originalReserve: 20, targetReserve: 100, parkedSoc: 90, baselineLoadW: 500, safetyExpiresAt: new Date() })).id;
  });
  it('only one of ten competing instances can own a hold', async () => {
    const wins = await Promise.all(Array.from({ length: 10 }, () => repo.claimHold(id, randomUUID())));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
  it('an expired owner cannot release or mutate its successor', async () => {
    const old = randomUUID(); const next = randomUUID();
    expect(await repo.claimHold(id, old)).toBe(true);
    await local.database.query(`UPDATE "BatteryHold" SET processing_expires_at=now()-interval '1 second' WHERE id=$1`, [id]);
    expect(await repo.claimHold(id, next)).toBe(true);
    await repo.releaseHold(id, old);
    expect(await repo.ownsHold(id, next)).toBe(true);
    expect(await repo.recordRestoreAttempt(id, old, 'manual')).toBe(false);
    expect(await repo.markRestored(id, 'manual', old)).toBe(false);
    expect(await repo.markCancelled(id, 'reserve_changed', 50, old)).toBe(false);
    expect(await repo.recordRestoreAttempt(id, next, 'manual')).toBe(true);
    expect(await repo.recordRestoreAttempt(id, next, 'manual')).toBe(false);
    expect(await repo.clearRestoreAttempt(id, old)).toBe(false);
    expect((await repo.getActiveHold('s'))?.restore_attempted_at).toBeInstanceOf(Date);
    expect(await repo.clearRestoreAttempt(id, next)).toBe(true);
    expect((await repo.getActiveHold('s'))?.restore_attempted_at).toBeNull();
    expect(await repo.recordRestoreAttempt(id, next, 'manual')).toBe(true);
  });
  it('allows an immediate post-reauth stop retry after a rejected command', async () => {
    const client = { getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }),
      setBackupReserve: vi.fn().mockRejectedValueOnce(new TeslaAuthError('Unauthorized', 401)).mockResolvedValueOnce({ Code: 200 }) };
    const deps: RestoreDeps = { client: client as unknown as RestoreDeps['client'], repo, siteId: 's', reason: 'manual' };
    expect((await restoreBattery(deps)).status).toBe('needs_reauth');
    const active = await repo.getActiveHold('s');
    expect(active?.restore_attempted_at).toBeNull();
    expect(active?.restore_reason).toBeNull();
    expect((await restoreBattery(deps)).status).toBe('ok');
    expect(client.setBackupReserve).toHaveBeenCalledTimes(2);
  });
  it('manual stop racing a monitor sends only one command', async () => {
    const owner = randomUUID(); await repo.claimHold(id, owner);
    const client = { getEnergySiteInfo: vi.fn().mockResolvedValue({ backup_reserve_percent: 100 }), setBackupReserve: vi.fn().mockResolvedValue({ Code: 200 }) };
    const deps: RestoreDeps = { client: client as unknown as RestoreDeps['client'], repo, siteId: 's', reason: 'manual' };
    const [monitor, manual] = await Promise.all([restoreBattery({ ...deps, expectedHoldId: id, leaseOwner: owner }), restoreBattery(deps)]);
    expect(monitor.status).toBe('ok'); expect(['error', 'no_active_hold']).toContain(manual.status);
    expect(client.setBackupReserve).toHaveBeenCalledTimes(1);
  });
  it('an old hold snapshot cannot restore a new hold on the same site', async () => {
    const owner = randomUUID(); await repo.claimHold(id, owner); await repo.markRestored(id, 'manual', owner);
    const replacement = await repo.createHold({ siteId: 's', originalReserve: 30, targetReserve: 80, parkedSoc: 70, baselineLoadW: 500, safetyExpiresAt: new Date() });
    const client = { setBackupReserve: vi.fn() };
    const result = await restoreBattery({ repo, siteId: 's', client: client as unknown as RestoreDeps['client'], reason: 'safety_timeout', expectedHoldId: id, leaseOwner: owner });
    expect(result.status).toBe('no_active_hold'); expect(client.setBackupReserve).not.toHaveBeenCalled();
    expect((await repo.getActiveHold('s'))?.id).toBe(replacement.id);
  });
  it('persists uncertainty across release/reclaim and guards the retry interval', async () => {
    const owner = randomUUID(); await repo.claimHold(id, owner); await repo.recordRestoreAttempt(id, owner, 'manual'); await repo.releaseHold(id, owner);
    expect((await repo.getActiveHold('s'))?.restore_attempted_at).toBeInstanceOf(Date);
    const next = randomUUID(); await repo.claimHold(id, next);
    expect(await repo.recordRestoreAttempt(id, next, 'manual')).toBe(false);
    await local.database.query(`UPDATE "BatteryHold" SET restore_attempted_at=now()-interval '16 minutes' WHERE id=$1`, [id]);
    expect(await repo.recordRestoreAttempt(id, next, 'manual')).toBe(true);
  });
  it('the scheduler migration retains cadence and sets the explicit pg_net budget', async () => {
    // Capture the cron SQL locally without installing pg_cron or calling HTTP.
    await local.database.query(`CREATE SCHEMA IF NOT EXISTS cron; CREATE TABLE IF NOT EXISTS cron.captured(name text PRIMARY KEY, schedule text, command text);
      CREATE OR REPLACE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO cron.captured VALUES ($1,$2,$3) ON CONFLICT(name) DO UPDATE SET schedule=$2,command=$3 RETURNING 1::bigint $$;`);
    await local.database.query(await readFile('db-migrations/20261014133707_battery_hold_cron_timeout.sql', 'utf8'));
    const row = (await local.database.query('SELECT * FROM cron.captured')).rows[0];
    expect(row.schedule).toBe('*/15 * * * *'); expect(row.command).toContain('timeout_milliseconds := 65000');
  });
});
