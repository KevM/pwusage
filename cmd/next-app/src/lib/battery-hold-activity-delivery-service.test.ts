import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock('./battery-hold-activity-repo', async (importOriginal) => ({
  ...await importOriginal<typeof import('./battery-hold-activity-repo')>(),
  reconcileBatteryHoldActivities: mocks.reconcile,
}));

import { deliverBatteryHoldActivities, retryDelayMs, type DeliveryDeps } from './battery-hold-activity-delivery-service';
import type { BatteryHoldActivityRepo, ClaimedActivity } from './battery-hold-activity-repo';
import type { ApnsCredentials, ApnsResult, ApnsSendRequest } from './battery-hold-apns';

const CREDS: ApnsCredentials = { keyId: 'ABC123DEFG', teamId: '6HQGHHRK87', privateKey: 'PRIVATE-KEY-MATERIAL', bundleId: 'fm.rodeo.pwusage' };
const TOKEN = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const snapshot = (status = 'active') => ({
  hold_id: 1, status, mode: 'auto', original_reserve: 20, target_reserve: 100,
  created_at: '2026-10-15T10:00:00.000Z', safety_expires_at: '2026-10-15T18:00:00.000Z',
  restored_at: status === 'active' ? null : '2026-10-15T11:00:00.000Z', restore_reason: null,
  cancelled_observed_reserve: null, monitoring: null,
});
const claimed = (id: number, overrides: Partial<ClaimedActivity> = {}): ClaimedActivity => ({
  id, pushToken: TOKEN(id), apnsEnvironment: 'sandbox', version: 1, attempts: 0,
  snapshot: snapshot(), expiresAt: new Date('2026-10-15T22:00:00.000Z'), ...overrides,
});

function fakeRepo(claims: ClaimedActivity[]) {
  return {
    claimForDelivery: vi.fn().mockResolvedValue(claims),
    completeDelivery: vi.fn().mockResolvedValue(true),
    deferDelivery: vi.fn().mockResolvedValue(true),
    disableInvalidToken: vi.fn().mockResolvedValue(true),
    releaseClaim: vi.fn().mockResolvedValue(true),
  };
}
type FakeRepo = ReturnType<typeof fakeRepo>;

function fakeClient(respond: (request: ApnsSendRequest) => ApnsResult | Promise<ApnsResult>) {
  return { send: vi.fn(async (request: ApnsSendRequest) => respond(request)), close: vi.fn().mockResolvedValue(undefined) };
}

const deps = (repo: FakeRepo, client: ReturnType<typeof fakeClient>, extra: Partial<DeliveryDeps> = {}): DeliveryDeps => ({
  credentials: CREDS, environments: ['sandbox'], repo: repo as unknown as BatteryHoldActivityRepo,
  createClient: () => client, ...extra,
});

describe('deliverBatteryHoldActivities', () => {
  let logs: string[];

  beforeEach(() => {
    mocks.reconcile.mockReset().mockResolvedValue(0);
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('is a no-op without APNs credentials: no database work and no client', async () => {
    const repo = fakeRepo([claimed(1)]);
    const createClient = vi.fn();
    const summary = await deliverBatteryHoldActivities({ ...deps(repo, fakeClient(() => ({ kind: 'accepted', apnsId: null }))), credentials: null, createClient });
    expect(summary.status).toBe('unconfigured');
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(repo.claimForDelivery).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('reconciles before claiming and opens no Apple connection when nothing is pending', async () => {
    const repo = fakeRepo([]);
    const createClient = vi.fn();
    const summary = await deliverBatteryHoldActivities({ ...deps(repo, fakeClient(() => ({ kind: 'accepted', apnsId: null }))), createClient });
    expect(summary).toMatchObject({ status: 'idle', claimed: 0 });
    expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(repo.claimForDelivery.mock.invocationCallOrder[0]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('claims a bounded batch for the allowed environments under one owner', async () => {
    const repo = fakeRepo([]);
    await deliverBatteryHoldActivities({ ...deps(repo, fakeClient(() => ({ kind: 'accepted', apnsId: null }))), environments: ['sandbox', 'production'] });
    expect(repo.claimForDelivery).toHaveBeenCalledWith({ owner: expect.stringMatching(/^[0-9a-f-]{36}$/), environments: ['sandbox', 'production'], limit: 50 });
  });

  it('acknowledges exactly the claimed version when APNs accepts it', async () => {
    const repo = fakeRepo([claimed(1, { version: 4 })]);
    const client = fakeClient(() => ({ kind: 'accepted', apnsId: 'x' }));
    const summary = await deliverBatteryHoldActivities(deps(repo, client));
    const owner = repo.claimForDelivery.mock.calls[0][0].owner;
    expect(repo.completeDelivery).toHaveBeenCalledWith(1, owner, 4);
    expect(summary).toMatchObject({ status: 'ran', claimed: 1, accepted: 1 });
    expect(client.send.mock.calls[0][0]).toMatchObject({ environment: 'sandbox', token: TOKEN(1), priority: 5 });
    expect(client.close).toHaveBeenCalled();
  });

  it('sends a terminal snapshot as an end event', async () => {
    const repo = fakeRepo([claimed(1, { snapshot: snapshot('restored') })]);
    const client = fakeClient(() => ({ kind: 'accepted', apnsId: null }));
    await deliverBatteryHoldActivities(deps(repo, client));
    expect(client.send.mock.calls[0][0].payload.aps.event).toBe('end');
  });

  it('disables an invalid token, passing the token it sent so a rotated one survives', async () => {
    const repo = fakeRepo([claimed(1)]);
    const summary = await deliverBatteryHoldActivities(deps(repo, fakeClient(() => ({ kind: 'invalid_token', reason: 'Unregistered' }))));
    expect(repo.disableInvalidToken).toHaveBeenCalledWith(1, expect.any(String), TOKEN(1), 'Unregistered');
    expect(summary.disabled).toBe(1);
  });

  it('backs off transient failures exponentially, respecting Apple 5xx guidance', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-15T12:00:00.000Z'), toFake: ['Date'] });
    const repo = fakeRepo([claimed(1, { attempts: 2 })]);
    const summary = await deliverBatteryHoldActivities(deps(repo, fakeClient(() => ({ kind: 'transient', reason: 'timeout' }))));
    expect(repo.deferDelivery).toHaveBeenCalledWith(1, expect.any(String), 1, { error: 'timeout', retryAt: new Date(Date.now() + 4 * 60_000) });
    expect(summary.deferred).toBe(1);
    expect(retryDelayMs(1, { kind: 'transient', reason: 'timeout' })).toBe(60_000);
    expect(retryDelayMs(20, { kind: 'transient', reason: 'timeout' })).toBe(30 * 60_000);
    expect(retryDelayMs(1, { kind: 'transient', reason: 'ServiceUnavailable' })).toBe(15 * 60_000);
    expect(retryDelayMs(1, { kind: 'transient', reason: 'http_502' })).toBe(15 * 60_000);
    expect(retryDelayMs(1, { kind: 'rejected', reason: 'BadPriority' })).toBe(30 * 60_000);
    expect(retryDelayMs(1, { kind: 'credentials', reason: 'InvalidProviderToken' })).toBe(5 * 60_000);
  });

  it('surfaces a credential failure and stops sending to that environment for this run', async () => {
    const repo = fakeRepo([claimed(1), claimed(2), claimed(3, { apnsEnvironment: 'production' })]);
    const client = fakeClient(request => (request.environment === 'sandbox'
      ? { kind: 'credentials', reason: 'InvalidProviderToken' } : { kind: 'accepted', apnsId: null }));
    const summary = await deliverBatteryHoldActivities({ ...deps(repo, client, { concurrency: 1 }), environments: ['sandbox', 'production'] });
    expect(summary.credentialFailure).toBe('InvalidProviderToken');
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(repo.deferDelivery).toHaveBeenCalledWith(1, expect.any(String), 1, expect.objectContaining({ error: 'InvalidProviderToken' }));
    expect(repo.releaseClaim).toHaveBeenCalledWith(2, expect.any(String));
    expect(repo.completeDelivery).toHaveBeenCalledWith(3, expect.any(String), 1);
    expect(logs.some(line => line.includes('credentials rejected') && line.includes('InvalidProviderToken'))).toBe(true);
  });

  it('defers a request APNs rejects and a snapshot it cannot build, without sending the latter', async () => {
    const repo = fakeRepo([claimed(1), claimed(2, { snapshot: { status: 'active' } })]);
    const client = fakeClient(() => ({ kind: 'rejected', reason: 'PayloadTooLarge' }));
    const summary = await deliverBatteryHoldActivities(deps(repo, client));
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(repo.deferDelivery).toHaveBeenCalledWith(1, expect.any(String), 1, expect.objectContaining({ error: 'PayloadTooLarge' }));
    expect(repo.deferDelivery).toHaveBeenCalledWith(2, expect.any(String), 1, expect.objectContaining({ error: 'InvalidSnapshot' }));
    expect(summary.rejected).toBe(2);
  });

  it('bounds parallel Apple requests', async () => {
    const repo = fakeRepo(Array.from({ length: 20 }, (_, i) => claimed(i + 1)));
    let inFlight = 0;
    let peak = 0;
    const client = fakeClient(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return { kind: 'accepted', apnsId: null };
    });
    const summary = await deliverBatteryHoldActivities(deps(repo, client, { concurrency: 4 }));
    expect(peak).toBe(4);
    expect(summary.accepted).toBe(20);
  });

  it('releases claims it has no time left to attempt', async () => {
    const repo = fakeRepo(Array.from({ length: 6 }, (_, i) => claimed(i + 1)));
    const client = fakeClient(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return { kind: 'transient', reason: 'timeout' };
    });
    const started = Date.now();
    const summary = await deliverBatteryHoldActivities(deps(repo, client, { concurrency: 2, sendBudgetMs: 150, requestTimeoutMs: 60 }));
    expect(Date.now() - started).toBeLessThan(400);
    expect(client.send.mock.calls.length).toBeLessThan(6);
    expect(summary.released).toBe(6 - client.send.mock.calls.length);
    expect(repo.releaseClaim).toHaveBeenCalledTimes(summary.released);
  });

  it('a failed bookkeeping write is logged without the token and does not stop the run', async () => {
    const repo = fakeRepo([claimed(1), claimed(2)]);
    repo.completeDelivery.mockRejectedValueOnce(Object.assign(new Error(`row ${TOKEN(1)}`), { code: '57014' }));
    const client = fakeClient(() => ({ kind: 'accepted', apnsId: null }));
    const summary = await deliverBatteryHoldActivities(deps(repo, client));
    expect(repo.completeDelivery).toHaveBeenCalledTimes(2);
    expect(summary.accepted).toBe(2);
    expect(client.close).toHaveBeenCalled();
    expect(logs.some(line => line.includes('57014'))).toBe(true);
  });

  it('closes the client even when the claim run fails part-way', async () => {
    const repo = fakeRepo([claimed(1)]);
    const client = fakeClient(() => { throw new Error('boom'); });
    const summary = await deliverBatteryHoldActivities(deps(repo, client));
    expect(client.close).toHaveBeenCalled();
    expect(repo.deferDelivery).toHaveBeenCalledWith(1, expect.any(String), 1, expect.objectContaining({ error: 'Error' }));
    expect(summary.deferred).toBe(1);
  });

  it('propagates a failed claim so the route reports it; nothing was claimed', async () => {
    const repo = fakeRepo([]);
    repo.claimForDelivery.mockRejectedValue(Object.assign(new Error('down'), { code: '08006' }));
    await expect(deliverBatteryHoldActivities(deps(repo, fakeClient(() => ({ kind: 'accepted', apnsId: null }))))).rejects.toThrow();
  });

  it('never logs tokens or signing material', async () => {
    const repo = fakeRepo([claimed(1), claimed(2), claimed(3)]);
    const results: ApnsResult[] = [
      { kind: 'credentials', reason: 'ExpiredProviderToken' }, { kind: 'invalid_token', reason: 'BadDeviceToken' }, { kind: 'rejected', reason: 'BadPriority' },
    ];
    let i = 0;
    await deliverBatteryHoldActivities({ ...deps(repo, fakeClient(() => results[i++]), { concurrency: 1 }), environments: ['sandbox'] });
    const output = logs.join('\n');
    for (const n of [1, 2, 3]) expect(output).not.toContain(TOKEN(n));
    expect(output).not.toContain(CREDS.privateKey);
  });
});
