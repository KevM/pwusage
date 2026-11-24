import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllMock, rawMock, evalMock, refreshMock, createClientMock, restoreMock, recordMock, deliverMock, order } = vi.hoisted(() => ({
  getAllMock: vi.fn(), rawMock: vi.fn(), evalMock: vi.fn(),
  refreshMock: vi.fn(), createClientMock: vi.fn(), restoreMock: vi.fn(), recordMock: vi.fn(), deliverMock: vi.fn(),
  order: [] as string[],
}));

vi.mock('@/lib/battery-hold-repo', () => ({ BatteryHoldRepo: class { getAllActiveHolds = getAllMock; recordMonitoring = recordMock;
  getActiveHold = async (siteId: string) => (await getAllMock()).find((hold: { site_id: string }) => hold.site_id === siteId);
  claimHold = async () => true; releaseHold = async () => undefined; } }));
vi.mock('@/lib/energy-repo-factory', () => ({ createEnergyRepo: () => ({ getRawEnergyData: rawMock }) }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = async (id: string) => ({ id, timezone: 'America/Chicago' }); } }));
vi.mock('@/lib/battery-hold-detection', () => ({ evaluateHold: evalMock }));
vi.mock('@/lib/today-refresh', () => ({ refreshTodayData: refreshMock }));
vi.mock('@/lib/battery-hold-service', () => ({ createSiteTeslaClient: createClientMock, restoreBattery: restoreMock }));
vi.mock('@/lib/nilm/tesla-adapter', () => ({ adaptTeslaData: (x: unknown) => x }));
vi.mock('@/lib/battery-hold-activity-repo', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/battery-hold-activity-repo')>(),
  reconcileBatteryHoldActivities: async () => { order.push('reconcile'); return 0; },
}));
vi.mock('@/lib/battery-hold-activity-delivery-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/battery-hold-activity-delivery-service')>(),
  deliverBatteryHoldActivities: deliverMock,
}));

import { GET, maxDuration } from './route';

const delivered = (overrides = {}) => ({
  status: 'ran', claimed: 1, accepted: 1, deferred: 0, disabled: 0, rejected: 0, released: 0, credentialFailure: null, runtimeMs: 5, ...overrides,
});

function req(auth?: string) {
  return { headers: { get: (k: string) => (k === 'authorization' ? auth : null) } } as unknown as Request;
}

describe('restore-reserve cron', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret');
    order.length = 0;
    deliverMock.mockReset().mockImplementation(async () => { order.push('deliver'); return delivered(); });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getAllMock.mockReset(); rawMock.mockReset(); evalMock.mockReset();
    refreshMock.mockReset(); createClientMock.mockReset(); restoreMock.mockReset(); recordMock.mockReset(); recordMock.mockResolvedValue(undefined);
    rawMock.mockResolvedValue([]); refreshMock.mockResolvedValue({ status: 'persisted' });
    createClientMock.mockResolvedValue({}); restoreMock.mockResolvedValue({ status: 'ok' });
  });

  it('401 without the cron secret, and never checks holds or delivers', async () => {
    expect((await GET(req('Bearer wrong') as never)).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(req('Bearer ') as never)).status).toBe(401);
    expect(getAllMock).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('delivers Live Activity updates after the hold check that produced them', async () => {
    getAllMock.mockResolvedValue([]);
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(order).toEqual(['reconcile', 'deliver']);
    expect(await res.json()).toMatchObject({ success: true, monitor: { processed: 0 }, delivery: { accepted: 1 } });
  });

  it('reports rejected APNs credentials as a failure so the trigger history shows it', async () => {
    getAllMock.mockResolvedValue([]);
    deliverMock.mockResolvedValue(delivered({ credentialFailure: 'InvalidProviderToken' }));
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'APNs credentials rejected', delivery: { credentialFailure: 'InvalidProviderToken' } });
  });

  it('still delivers when active holds cannot be read, without exposing the error', async () => {
    getAllMock.mockRejectedValue(new Error('private database error'));
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(503);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await res.json())).not.toContain('private database error');
  });

  it('503 when delivery cannot start, without exposing the error; the hold check still counts', async () => {
    getAllMock.mockResolvedValue([]);
    deliverMock.mockRejectedValue(new Error('db down'));
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(503);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('db down');
    expect(body).toContain('"processed":0');
  });

  it('stays inside the Hobby 60 s cap', () => {
    expect(maxDuration).toBe(60);
  });

  it('restores holds the detector flags', async () => {
    getAllMock.mockResolvedValue([{ id: 1, site_id: 's1', created_at: new Date(), safety_expires_at: new Date(Date.now() + 3600000) }]);
    evalMock.mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValue({ restore: true, reason: 'load_ended' });
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(restoreMock).toHaveBeenCalledWith(expect.objectContaining({ siteId: 's1', reason: 'load_ended' }));
  });

  it('leaves holds the detector keeps', async () => {
    getAllMock.mockResolvedValue([{ id: 1, site_id: 's1', created_at: new Date(), safety_expires_at: new Date(Date.now() + 3600000) }]);
    evalMock.mockReturnValue(null);
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(restoreMock).not.toHaveBeenCalled();
  });

  it('timer-mode holds skip the data refresh and NILM fetch', async () => {
    getAllMock.mockResolvedValue([{ id: 2, site_id: 's2', mode: 'timer', created_at: new Date(), safety_expires_at: new Date() }]);
    evalMock.mockReturnValue({ restore: true, reason: 'timer_elapsed' });
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(rawMock).not.toHaveBeenCalled();
    expect(restoreMock).toHaveBeenCalledWith(expect.objectContaining({ siteId: 's2', reason: 'timer_elapsed' }));
  });
  it('persists a check failure without exposing internal errors', async () => {
    getAllMock.mockResolvedValue([{ id: 1, site_id: 's1', created_at: new Date(), safety_expires_at: new Date(Date.now() + 3600000) }]);
    rawMock.mockRejectedValue(new Error('private database error'));
    await GET(req('Bearer secret') as never);
    expect(recordMock).toHaveBeenCalledWith(1, expect.objectContaining({ phase: 'check_failed' }));
  });
  it('monitoring write errors never prevent restoration', async () => {
    getAllMock.mockResolvedValue([{ id: 1, site_id: 's1', created_at: new Date(), safety_expires_at: new Date(Date.now() + 3600000) }]);
    evalMock.mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValue({ restore: true, reason: 'load_ended' });
    recordMock.mockRejectedValue(new Error('write failed'));
    await GET(req('Bearer secret') as never);
    expect(restoreMock).toHaveBeenCalled();
  });

});
