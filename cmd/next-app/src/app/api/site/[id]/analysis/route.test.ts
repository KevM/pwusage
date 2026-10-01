import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ policy: vi.fn(), raw: vi.fn(), tags: vi.fn(), client: vi.fn(), sync: vi.fn(), audit: vi.fn(), access: vi.fn() }));
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() } }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'token' }) }) }));
vi.mock('@/lib/site-service', () => ({ SiteService: class { validateSiteAccess = mocks.access; } }));
vi.mock('@/lib/site-repo', () => ({ SiteRepo: class { getSite = async () => ({ id: 's1', user_id: 'u1', timezone: 'UTC', tariffs: [] }); } }));
vi.mock('@/lib/user-repo', () => ({ UserRepo: class { getHistoryRetention = mocks.policy; } }));
vi.mock('@/lib/energy-repo', () => ({ EnergyRepo: class { getRawEnergyData = mocks.raw; } }));
vi.mock('@/lib/load-tag-repo', () => ({ LoadTagRepo: class { getLoadTags = mocks.tags; } }));
vi.mock('@/lib/tesla-client-factory', () => ({ createTeslaClientForSite: mocks.client }));
vi.mock('@/lib/importer', () => ({ Importer: class { ensureDataForRange = mocks.sync; auditRange = mocks.audit; } }));
import { GET } from './route';
const policy = { history_retention_days: 90, history_retention_grace_until: null, history_retention_transition_pending: false };
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T18:00:00Z'));
    mocks.access.mockResolvedValue(true); mocks.policy.mockResolvedValue(policy);
    mocks.raw.mockResolvedValue([]); mocks.tags.mockResolvedValue([]); mocks.audit.mockResolvedValue([]); mocks.client.mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());
const request = (date: string, timezone = 'UTC') => GET(new NextRequest(`https://example.test/api/site/s1/analysis?date=${date}&tz=${timezone}&force=true`), { params: Promise.resolve({ id: 's1' }) });
describe('analysis retention boundary', () => {
    it('returns a terminal expired result without Tesla, energy, tag, or audit requests', async () => {
        const response = await request('2026-07-02');
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ data: [], events: [], audit: [], historyAvailability: { status: 'unavailable', effectiveDays: 90 } });
        for (const operation of [mocks.client, mocks.sync, mocks.raw, mocks.tags, mocks.audit]) expect(operation).not.toHaveBeenCalled();
    });
    it('clamps a browser day crossing the site cutoff before sync and raw reads', async () => {
        const response = await request('2026-07-02', 'America/Los_Angeles');
        expect((await response.json()).historyAvailability.status).toBe('partial');
        expect(mocks.raw).toHaveBeenCalledWith('s1', new Date('2026-07-03T00:00:00Z'), new Date('2026-07-03T07:00:00Z'));
        expect(mocks.sync.mock.calls[0][1]).toEqual(new Date('2026-07-03T00:00:00Z'));
    });
    it('keeps extended account history available', async () => {
        mocks.policy.mockResolvedValue({ ...policy, history_retention_days: 365 });
        expect((await (await request('2026-07-02')).json()).historyAvailability.status).toBe('available');
        expect(mocks.raw).toHaveBeenCalledOnce();
    });
    it('does not read policy before site authorization', async () => {
        mocks.access.mockResolvedValue(false);
        expect((await request('2026-07-02')).status).toBe(403);
        expect(mocks.policy).not.toHaveBeenCalled();
    });
});
