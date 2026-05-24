import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, parkMock, restoreMock, getActiveMock, createClientMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(), parkMock: vi.fn(), restoreMock: vi.fn(),
  getActiveMock: vi.fn(), createClientMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/battery-hold-service', () => ({
  parkBattery: parkMock, restoreBattery: restoreMock, createSiteTeslaClient: createClientMock,
}));
vi.mock('@/lib/battery-hold-repo', () => ({
  BatteryHoldRepo: class { getActiveHold = getActiveMock; },
}));

import { GET, POST } from './route';

function req(body?: unknown) {
  return { json: async () => body } as unknown as Request;
}
const ctx = { params: Promise.resolve({ id: 'site-1' }) };

describe('battery-hold route', () => {
  beforeEach(() => {
    verifyMock.mockReset(); parkMock.mockReset(); restoreMock.mockReset();
    getActiveMock.mockReset(); createClientMock.mockReset();
    verifyMock.mockResolvedValue(true);
    createClientMock.mockResolvedValue({});
  });

  it('GET returns the active hold', async () => {
    getActiveMock.mockResolvedValue({ id: 1 });
    const res = await GET(req() as never, ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hold: { id: 1 } });
  });

  it('GET 403 when unauthorized', async () => {
    verifyMock.mockResolvedValue(false);
    const res = await GET(req() as never, ctx as never);
    expect(res.status).toBe(403);
  });

  it('POST park returns 200 ok', async () => {
    parkMock.mockResolvedValue({ status: 'ok', hold: { id: 2 } });
    const res = await POST(req({ action: 'park' }) as never, ctx as never);
    expect(res.status).toBe(200);
    expect(parkMock).toHaveBeenCalled();
  });

  it('POST maps needs_reauth to 409', async () => {
    parkMock.mockResolvedValue({ status: 'needs_reauth' });
    const res = await POST(req({ action: 'park' }) as never, ctx as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'needs_reauth' });
  });

  it('POST 409 when no client (no tokens)', async () => {
    createClientMock.mockResolvedValue(null);
    const res = await POST(req({ action: 'park' }) as never, ctx as never);
    expect(res.status).toBe(409);
  });

  it('POST 400 on unknown action', async () => {
    const res = await POST(req({ action: 'nope' }) as never, ctx as never);
    expect(res.status).toBe(400);
  });
});
