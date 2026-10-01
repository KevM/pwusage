import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./auth-jwt', () => ({ verifySiteToken: () => ({ sub: 'u1', sites: ['s1'], roles: [] }) }));
vi.mock('./db', () => ({ pool: { query: vi.fn() } }));
import { SiteService } from './site-service';
import { SiteRepo } from './site-repo';
import { TeslaClient } from './tesla-client';
const policy = { history_retention_days: 90, history_retention_grace_until: null, history_retention_transition_pending: false };
afterEach(() => vi.useRealTimers());
describe('site billing retention', () => {
    for (const [date, status, expectedStart] of [
        ['2026-10-01', 'available', '2026-10-01T00:00:00.000Z'],
        ['2026-09-01', 'available', '2026-09-01T00:00:00.000Z'],
        ['2026-07-01', 'partial', '2026-07-03T00:00:00.000Z'],
        ['2026-06-01', 'unavailable', null],
    ] as const) {
        it(`marks ${date} ${status} and bounds reads`, async () => {
            vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T18:00:00Z'));
            const usage = vi.fn().mockResolvedValue([]);
            const retention = vi.fn().mockResolvedValue(policy);
            const service = new SiteService({
                siteRepo: { getSite: vi.fn().mockResolvedValue({ id: 's1', user_id: 'u1', timezone: 'UTC', billing_start_day: 1, tariffs: [] }) } as unknown as SiteRepo,
                siteAuthToken: 'token', isUserActive: async () => true,
                getHistoryRetention: retention,
                energyRepo: { hasData: async () => true, getUsageByTOU: usage },
                teslaTokenRepo: { getLockedRefreshHandler: () => ({ refreshHandler: vi.fn(), errorHandler: vi.fn() }) },
                trmnlService: { getInstallationBySiteId: async () => undefined },
                teslaClientCreator: () => ({} as TeslaClient),
                importerCreator: () => ({ ensureSite: vi.fn() }),
            });
            const result = await service.loadSitePageData('s1', date);
            expect(retention).toHaveBeenCalledExactlyOnceWith('u1');
            expect(result.status).toBe('ready');
            if (result.status !== 'ready') throw new Error('Expected ready');
            expect(result.historyAvailability.status).toBe(status);
            expect(result.earliestDate).toBe('2026-07-03');
            expect(result.earliestMonth).toBe('2026-07');
            expect(result.canGoPrevious).toBe(status === 'available');
            if (expectedStart) expect(usage).toHaveBeenCalledWith('s1', new Date(expectedStart), expect.any(Date));
            else expect(usage).not.toHaveBeenCalled();
        });
    }
});
