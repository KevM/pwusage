import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('./db', () => ({ pool: { query: queryMock } }));

import {
  ACTIVITY_SYNC_BUDGET_MS, activityErrorTag, allowedApnsEnvironments, reconcileBatteryHoldActivities,
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

describe('activityErrorTag', () => {
  it('prefers the SQLSTATE and never includes the message or detail', () => {
    const e = Object.assign(new Error(`bad ${TOKEN}`), { code: '23514', detail: `Failing row contains (${TOKEN})` });
    expect(activityErrorTag(e)).toBe('23514');
  });

  it('tags the I/O deadline, other errors by name, and non-errors as unknown', () => {
    expect(activityErrorTag(new Error('I/O deadline exceeded'))).toBe('deadline');
    expect(activityErrorTag(new TypeError(`secret ${TOKEN}`))).toBe('TypeError');
    expect(activityErrorTag('boom')).toBe('unknown');
    expect(activityErrorTag(null)).toBe('unknown');
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

  it('logs a token-free cause tag: the SQLSTATE for database errors', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error(`bad ${TOKEN}`), { code: '42P01', detail: TOKEN }));
    await expect(reconcileBatteryHoldActivities()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[BatteryHold] Activity state sync deferred', '42P01');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('returns null within the budget when the query never resolves', async () => {
    vi.useFakeTimers();
    queryMock.mockReturnValue(new Promise(() => {}));
    const pending = reconcileBatteryHoldActivities();
    await vi.advanceTimersByTimeAsync(ACTIVITY_SYNC_BUDGET_MS);
    await expect(pending).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[BatteryHold] Activity state sync deferred', 'deadline');
  });
});
