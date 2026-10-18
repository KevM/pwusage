import { beforeEach, describe, expect, it, vi } from 'vitest';

const { healMock } = vi.hoisted(() => ({ healMock: vi.fn() }));
vi.mock('@/lib/gap-heal', () => ({ healTrailingGaps: healMock }));

import { GET, maxDuration } from './route';

function req(auth?: string) {
  return { headers: { get: (k: string) => (k === 'authorization' ? auth : null) } } as unknown as Request;
}

describe('heal-gaps cron', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret');
    healMock.mockReset().mockResolvedValue({
      sites: [
        { siteId: 'a', status: 'complete', processedWindows: 0, totalWindows: 0 },
        { siteId: 'b', status: 'partial', processedWindows: 3, totalWindows: 5 },
      ],
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('401 without the cron secret, and never heals', async () => {
    expect((await GET(req('Bearer wrong') as never)).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(req('Bearer ') as never)).status).toBe(401);
    expect(healMock).not.toHaveBeenCalled();
  });

  it('runs one bounded heal and returns its summary', async () => {
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, sites: [{ siteId: 'a' }, { siteId: 'b', status: 'partial' }] });
    expect(healMock).toHaveBeenCalledTimes(1);
  });

  it('503 without leaking the error when the heal cannot run', async () => {
    healMock.mockRejectedValue(new Error('db down'));
    const res = await GET(req('Bearer secret') as never);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('db down');
  });

  it('stays within the Hobby 60 s cap', () => {
    expect(maxDuration).toBe(60);
  });
});
