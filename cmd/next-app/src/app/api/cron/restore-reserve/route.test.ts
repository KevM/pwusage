import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllMock, rawMock, evalMock, refreshMock, createClientMock, restoreMock, recordMock } = vi.hoisted(() => ({
  getAllMock: vi.fn(), rawMock: vi.fn(), evalMock: vi.fn(),
  refreshMock: vi.fn(), createClientMock: vi.fn(), restoreMock: vi.fn(), recordMock: vi.fn(),
}));

vi.mock('@/lib/battery-hold-repo', () => ({ BatteryHoldRepo: class { getAllActiveHolds = getAllMock; recordMonitoring = recordMock;
  claimHold = async () => true; releaseHold = async () => undefined; } }));
vi.mock('@/lib/energy-repo-factory', () => ({ createEnergyRepo: () => ({ getRawEnergyData: rawMock }) }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = async (id: string) => ({ id, timezone: 'America/Chicago' }); } }));
vi.mock('@/lib/battery-hold-detection', () => ({ evaluateHold: evalMock }));
vi.mock('@/lib/today-refresh', () => ({ refreshTodayData: refreshMock }));
vi.mock('@/lib/battery-hold-service', () => ({ createSiteTeslaClient: createClientMock, restoreBattery: restoreMock }));
vi.mock('@/lib/nilm/tesla-adapter', () => ({ adaptTeslaData: (x: unknown) => x }));

import { GET } from './route';

function req(auth?: string) {
  return { headers: { get: (k: string) => (k === 'authorization' ? auth : null) } } as unknown as Request;
}

describe('restore-reserve cron', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret');
    getAllMock.mockReset(); rawMock.mockReset(); evalMock.mockReset();
    refreshMock.mockReset(); createClientMock.mockReset(); restoreMock.mockReset(); recordMock.mockReset(); recordMock.mockResolvedValue(undefined);
    rawMock.mockResolvedValue([]); refreshMock.mockResolvedValue({ status: 'persisted' });
    createClientMock.mockResolvedValue({}); restoreMock.mockResolvedValue({ status: 'ok' });
  });

  it('401 without the cron secret', async () => {
    const res = await GET(req('Bearer wrong') as never);
    expect(res.status).toBe(401);
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
