import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, parkMock, restoreMock, getActiveMock, getNoticeMock, ackMock, createClientMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(), parkMock: vi.fn(), restoreMock: vi.fn(),
  getActiveMock: vi.fn(), getNoticeMock: vi.fn(), ackMock: vi.fn(), createClientMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ verifySiteAccess: verifyMock }));
vi.mock('@/lib/battery-hold-service', () => ({
  parkBattery: parkMock, restoreBattery: restoreMock, createSiteTeslaClient: createClientMock,
}));
vi.mock('@/lib/battery-hold-repo', () => ({
  BatteryHoldRepo: class {
    getActiveHold = getActiveMock;
    getLatestCancelledUnacked = getNoticeMock;
    acknowledge = ackMock;
  },
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
    getNoticeMock.mockReset(); ackMock.mockReset();
    verifyMock.mockResolvedValue(true);
    createClientMock.mockResolvedValue({});
    getNoticeMock.mockResolvedValue(null);
  });

  it('GET returns the active hold and the notice', async () => {
    getActiveMock.mockResolvedValue({ id: 1 });
    getNoticeMock.mockResolvedValue({ id: 9 });
    const res = await GET(req() as never, ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hold: { id: 1 }, notice: { id: 9 } });
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

  it('POST park with invalid timer duration returns 400', async () => {
    const res = await POST(req({ action: 'park', mode: 'timer', durationHours: 0 }) as never, ctx as never);
    expect(res.status).toBe(400);
    expect(parkMock).not.toHaveBeenCalled();
  });

  it('POST park forwards mode/duration/reserveChoice to the service', async () => {
    parkMock.mockResolvedValue({ status: 'ok', hold: { id: 2 } });
    await POST(req({ action: 'park', mode: 'timer', durationHours: 4, reserveChoice: 80 }) as never, ctx as never);
    expect(parkMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'timer', durationHours: 4, reserveChoice: 80 }));
  });

  it('POST park needs_choice maps to 422 with options', async () => {
    parkMock.mockResolvedValue({ status: 'needs_choice', options: [80, 100] });
    const res = await POST(req({ action: 'park', mode: 'auto' }) as never, ctx as never);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'needs_choice', options: [80, 100] });
  });

  it('POST restore reserve_changed maps to 200 with current', async () => {
    restoreMock.mockResolvedValue({ status: 'reserve_changed', current: 50 });
    const res = await POST(req({ action: 'restore' }) as never, ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'reserve_changed', current: 50 });
  });

  it('POST dismiss acknowledges the latest notice', async () => {
    getNoticeMock.mockResolvedValue({ id: 9 });
    const res = await POST(req({ action: 'dismiss' }) as never, ctx as never);
    expect(res.status).toBe(200);
    expect(ackMock).toHaveBeenCalledWith(9);
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
