import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { BatteryHoldMonitoring } from './battery-hold-monitoring';

const local = vi.hoisted(() => ({ database: undefined as unknown as import('pg').Pool }));
vi.mock('./db', () => ({ pool: {
  query: (...args: unknown[]) => Reflect.apply(local.database.query, local.database, args),
  connect: () => local.database.connect(),
} }));
// The monitor's Tesla-facing steps return at once, so its runtime is pure scheduling and database work.
vi.mock('./today-refresh', () => ({ refreshTodayData: async () => ({ status: 'persisted' }) }));
vi.mock('./energy-repo', () => ({ EnergyRepo: class { getRawEnergyData = async () => []; } }));

import { BatteryHoldRepo } from './battery-hold-repo';
import { BatteryHoldActivityRepo, type ActivityRegistration } from './battery-hold-activity-repo';
import { deliverBatteryHoldActivities, type DeliveryDeps } from './battery-hold-activity-delivery-service';
import { ApnsClient, resetProviderTokenCache, type ApnsCredentials, type LiveActivityPayload } from './battery-hold-apns';
import { monitorBatteryHolds } from './battery-hold-monitor-service';
import { apnsReply, startMockApns, type ApnsResponder } from './apns-mock-server';
import { createActivityTestDatabase, safeActivityTestSocket } from './battery-hold-activity-test-db';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const CREDS: ApnsCredentials = {
  keyId: 'ABC123DEFG', teamId: '6HQGHHRK87', bundleId: 'fm.rodeo.pwusage',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const monitoring = (checked_at: string): BatteryHoldMonitoring => ({
  phase: 'watching', checked_at, next_check_at: '2026-10-15T10:30:00.000Z', sampled_at: null, estimated_load_w: null,
});

describe.skipIf(!safeActivityTestSocket)('Live Activity delivery against a mock APNs', () => {
  const repo = new BatteryHoldActivityRepo();
  const holdRepo = new BatteryHoldRepo();
  let apple: Awaited<ReturnType<typeof startMockApns>> | undefined;
  let holdId: number;

  const rows = async () => (await local.database.query('SELECT * FROM "BatteryHoldActivity" ORDER BY id')).rows;
  const payloads = () => apple!.received.map(r => JSON.parse(r.body) as LiveActivityPayload);
  const createHold = async (siteId: string) => (await holdRepo.createHold({
    siteId, originalReserve: 20, targetReserve: 100, parkedSoc: 90, baselineLoadW: 500,
    safetyExpiresAt: new Date(Date.now() + 6 * 3600_000),
  })).id;
  const register = async (overrides: Partial<ActivityRegistration> = {}) => {
    await repo.register({ holdId, userId: 'u1', registrationId: randomUUID(), pushToken: randomUUID().replace(/-/g, '').repeat(2), apnsEnvironment: 'sandbox', ...overrides });
  };
  const useApple = async (respond: ApnsResponder) => { apple = await startMockApns(respond); return apple; };
  const deliver = (extra: Partial<DeliveryDeps> = {}) => deliverBatteryHoldActivities({
    credentials: CREDS, environments: ['sandbox'],
    createClient: credentials => new ApnsClient({
      credentials, origins: { sandbox: apple!.origin, production: apple!.origin }, requestTimeoutMs: extra.requestTimeoutMs,
    }),
    ...extra,
  });

  beforeAll(async () => { local.database = await createActivityTestDatabase('battery_hold_activity_delivery_test'); });
  afterAll(async () => { await local.database?.end(); });

  beforeEach(async () => {
    await local.database.query('TRUNCATE "BatteryHoldActivity", "BatteryHold", "Site", "User" CASCADE');
    await local.database.query(`INSERT INTO "User" (id, roles) VALUES ('u1', '{}')`);
    await local.database.query(`INSERT INTO "Site" (id, user_id) SELECT 's' || n, 'u1' FROM generate_series(1, 10) n`);
    holdId = await createHold('s1');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await apple?.close();
    apple = undefined;
    resetProviderTokenCache();
    vi.restoreAllMocks();
  });

  it('sends the update, then the end, in order; the accepted end drops the token', async () => {
    await useApple(apnsReply(200));
    await register();
    expect(await deliver()).toMatchObject({ status: 'ran', accepted: 1 });
    expect((await rows())[0]).toMatchObject({ delivery_state: 'current', delivered_version: 1 });
    await holdRepo.markRestored(holdId, 'manual');
    // The run's own reconcile picks up the terminal transition.
    expect(await deliver()).toMatchObject({ accepted: 1 });
    const [update, end] = payloads();
    expect(update.aps.event).toBe('update');
    expect(end.aps.event).toBe('end');
    expect(end.aps['content-state'].status).toBe('restored');
    expect(end.aps.timestamp).toBeGreaterThanOrEqual(update.aps.timestamp);
    expect(apple!.received[1].headers['apns-priority']).toBe('10');
    expect((await rows())[0]).toMatchObject({ delivery_state: 'ended', delivered_version: 2, push_token: null });
    expect(await deliver()).toMatchObject({ status: 'idle' });
    expect(apple!.received).toHaveLength(2);
  });

  it('APNs acceptance is not device delivery: a later Unregistered still disables the registration', async () => {
    let status = 200;
    await useApple((stream, headers, body) => apnsReply(status, status === 200 ? undefined : { reason: 'Unregistered' })(stream, headers, body));
    await register();
    await deliver();
    expect((await rows())[0].delivery_state).toBe('current');
    status = 410;
    await holdRepo.recordMonitoring(holdId, monitoring(new Date().toISOString()));
    expect(await deliver()).toMatchObject({ disabled: 1 });
    expect((await rows())[0]).toMatchObject({ delivery_state: 'disabled', disabled_reason: 'Unregistered', push_token: null });
  });

  it('a transient Apple failure backs off and keeps the version pending', async () => {
    await useApple(apnsReply(503, { reason: 'ServiceUnavailable' }));
    await register();
    expect(await deliver()).toMatchObject({ deferred: 1 });
    const [row] = await rows();
    expect(row).toMatchObject({ delivery_state: 'pending', delivered_version: 0, attempt_count: 1, last_error: 'ServiceUnavailable', claim_owner: null });
    expect(new Date(row.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await deliver()).toMatchObject({ status: 'idle' });
    expect(apple!.received).toHaveLength(1);
  });

  it('an authentication failure is surfaced, stops the run and leaves every row pending', async () => {
    await useApple(apnsReply(403, { reason: 'InvalidProviderToken' }));
    for (let i = 0; i < 3; i++) await register();
    const summary = await deliver({ concurrency: 1 });
    expect(summary).toMatchObject({ credentialFailure: 'InvalidProviderToken', deferred: 1, released: 2 });
    expect(apple!.received).toHaveLength(1);
    const all = await rows();
    expect(all.every(r => r.delivery_state === 'pending' && r.claim_owner === null && r.push_token)).toBe(true);
    expect(all.map(r => r.attempt_count).sort()).toEqual([0, 0, 1]);
  });

  it('overlapping runs send each pending version exactly once', async () => {
    await useApple((stream, headers, body) => { setTimeout(() => apnsReply(200)(stream, headers, body), 50); });
    for (let i = 0; i < 5; i++) await register();
    const [a, b] = await Promise.all([deliver(), deliver()]);
    expect(a.accepted + b.accepted).toBe(5);
    expect(new Set(apple!.received.map(r => r.headers[':path'])).size).toBe(5);
    expect(apple!.received).toHaveLength(5);
    expect((await rows()).every(r => r.delivery_state === 'current')).toBe(true);
  });

  it('new desired state arriving during delivery stays pending and goes out on the next run', async () => {
    const checkedAt = new Date(Date.now() + 1000).toISOString();
    let first = true;
    await useApple((stream, headers, body) => {
      if (!first) { apnsReply(200)(stream, headers, body); return; }
      first = false;
      void holdRepo.recordMonitoring(holdId, monitoring(checkedAt))
        .then(() => repo.syncDesired(holdId))
        .then(() => apnsReply(200)(stream, headers, body));
    });
    await register();
    await deliver();
    expect((await rows())[0]).toMatchObject({ delivery_state: 'pending', delivered_version: 1, desired_version: 2 });
    await deliver();
    expect((await rows())[0]).toMatchObject({ delivery_state: 'current', delivered_version: 2 });
    expect(payloads()[1].aps['content-state'].checkedAt).toBe(Math.floor(Date.parse(checkedAt) / 1000) - 978307200);
  });

  describe('ten holds with three phones each', () => {
    beforeEach(async () => {
      const holds = [holdId];
      for (let n = 2; n <= 10; n++) holds.push(await createHold(`s${n}`));
      for (const id of holds) for (let i = 0; i < 3; i++) await register({ holdId: id });
    });

    it('a failing Apple endpoint defers all thirty registrations within one bounded run', async () => {
      await useApple(apnsReply(500, { reason: 'InternalServerError' }));
      const summary = await deliver();
      expect(summary).toMatchObject({ claimed: 30, deferred: 30, accepted: 0 });
      expect(summary.runtimeMs).toBeLessThan(5000);
      expect((await rows()).every(r => r.delivery_state === 'pending' && r.attempt_count === 1 && r.claim_owner === null)).toBe(true);
    });

    it('a hung Apple endpoint is bounded by the run budget, and the battery monitor is unaffected', async () => {
      await useApple(() => undefined);
      const holds = await holdRepo.getAllActiveHolds();
      expect(holds).toHaveLength(10);
      const baseline = await monitorBatteryHolds(holds);
      expect(baseline.results.every(r => r.status === 'holding')).toBe(true);

      const delivery = deliver({ requestTimeoutMs: 300, sendBudgetMs: 1000 });
      await new Promise(resolve => setTimeout(resolve, 50));
      const monitor = await monitorBatteryHolds(await holdRepo.getAllActiveHolds());
      const summary = await delivery;

      expect(monitor.results.every(r => r.status === 'holding')).toBe(true);
      expect(monitor.activitiesSynced).not.toBeNull();
      expect(monitor.runtimeMs).toBeLessThan(baseline.runtimeMs + 500);
      expect(monitor.runtimeMs).toBeLessThan(summary.runtimeMs);
      expect(summary.runtimeMs).toBeLessThan(2000);
      expect(summary.claimed).toBe(30);
      expect(summary.deferred + summary.released).toBe(30);
      expect(summary.released).toBeGreaterThan(0);
      const all = await rows();
      expect(all.every(r => r.delivery_state === 'pending' && r.claim_owner === null)).toBe(true);
      expect(all.filter(r => r.last_error === 'timeout')).toHaveLength(summary.deferred);
    });
  });
});
