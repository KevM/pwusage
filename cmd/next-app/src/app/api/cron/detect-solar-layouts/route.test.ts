import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock('@/lib/solar-layout/run-detections', () => ({ runDueDetections: runMock }));
vi.mock('@/lib/solar-layout-repo', () => ({ SolarLayoutRepo: class {} }));
vi.mock('@/lib/energy-repo-factory', () => ({ createEnergyRepo: vi.fn() }));

import { GET, maxDuration } from './route';

function req(auth?: string) {
  return { headers: { get: (k: string) => (k === 'authorization' ? auth : null) } } as unknown as Request;
}

describe('detect-solar-layouts cron', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret');
    runMock.mockReset().mockResolvedValue({ sites: [{ siteId: 'a', status: 'detected', ms: 4100 }], stopped: false });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('401 without the cron secret, and never detects', async () => {
    expect((await GET(req('Bearer wrong') as never)).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(req('Bearer ') as never)).status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('runs one bounded pass with a 35 s budget and returns its summary', async () => {
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, sites: [{ siteId: 'a', status: 'detected' }], stopped: false });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][0]).toMatchObject({ budgetMs: 35_000 });
  });

  it('503 without leaking the error when detection cannot run', async () => {
    runMock.mockRejectedValue(new Error('db down'));
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('db down');
  });

  it('stays within the Hobby 60 s cap', () => {
    expect(maxDuration).toBe(60);
  });
});
