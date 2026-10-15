import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('./db', () => ({ pool: { query: queryMock } }));

import {
  ACTIVITY_SYNC_BUDGET_MS, allowedApnsEnvironments, reconcileBatteryHoldActivities,
} from './battery-hold-activity-repo';

const TOKEN = 'f'.repeat(64);

describe('allowedApnsEnvironments', () => {
  it('allows production APNs only on the production deployment', () => {
    expect(allowedApnsEnvironments({ VERCEL_ENV: 'production' })).toEqual(['sandbox', 'production']);
    for (const env of ['preview', 'development']) {
      expect(allowedApnsEnvironments({ VERCEL_ENV: env })).toEqual(['sandbox']);
    }
    expect(allowedApnsEnvironments({})).toEqual(['sandbox']);
  });
});

describe('reconcileBatteryHoldActivities', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryMock.mockReset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  it('never throws and returns null when the query rejects, without logging the token', async () => {
    queryMock.mockRejectedValue(new Error(`connection failed for ${TOKEN}`));
    await expect(reconcileBatteryHoldActivities(1)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('returns null within the budget when the query never resolves', async () => {
    vi.useFakeTimers();
    queryMock.mockReturnValue(new Promise(() => {}));
    const pending = reconcileBatteryHoldActivities();
    await vi.advanceTimersByTimeAsync(ACTIVITY_SYNC_BUDGET_MS);
    await expect(pending).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
