import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deliverMock } = vi.hoisted(() => ({ deliverMock: vi.fn() }));
vi.mock('@/lib/battery-hold-activity-delivery-service', () => ({ deliverBatteryHoldActivities: deliverMock }));

import { GET, maxDuration } from './route';

function req(auth?: string) {
  return { headers: { get: (k: string) => (k === 'authorization' ? auth : null) } } as unknown as Request;
}
const summary = (overrides = {}) => ({
  status: 'ran', claimed: 1, accepted: 1, deferred: 0, disabled: 0, rejected: 0, released: 0, credentialFailure: null, runtimeMs: 5, ...overrides,
});

describe('battery-hold-activity-delivery cron', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret');
    deliverMock.mockReset().mockResolvedValue(summary());
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('401 without the cron secret, and never runs delivery', async () => {
    expect((await GET(req('Bearer wrong') as never)).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(req('Bearer ') as never)).status).toBe(401);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('awaits one delivery run and returns its summary', async () => {
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, accepted: 1 });
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('reports rejected APNs credentials as a failure so the trigger history shows it', async () => {
    deliverMock.mockResolvedValue(summary({ credentialFailure: 'InvalidProviderToken' }));
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'APNs credentials rejected', credentialFailure: 'InvalidProviderToken' });
  });

  it('503 when delivery cannot start; pending rows stay for the next run', async () => {
    deliverMock.mockRejectedValue(new Error('db down'));
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('db down');
  });

  it('keeps its own budget well under the Hobby 60 s cap', () => {
    expect(maxDuration).toBe(30);
  });
});
