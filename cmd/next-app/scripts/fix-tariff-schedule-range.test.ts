import { describe, it, expect } from 'vitest';
import { getSiteLocalRepairBounds } from './fix-tariff-schedule-range';

describe('fix-tariff-schedule-range helper', () => {
    it('derives site-local bounds for America/Chicago (UTC-5 in summer)', () => {
        const { siteStart, siteEnd } = getSiteLocalRepairBounds('2026-07-03', '2026-07-04', 'America/Chicago');

        // July 3 00:00:00 CDT is 2026-07-03T05:00:00.000Z
        expect(siteStart.toISOString()).toBe('2026-07-03T05:00:00.000Z');
        // July 4 00:00:00 CDT is 2026-07-04T05:00:00.000Z
        expect(siteEnd.toISOString()).toBe('2026-07-04T05:00:00.000Z');
    });

    it('covers July 3 local evening (e.g. 19:00 CDT = 2026-07-04T00:00Z) within the site-local window', () => {
        const { siteStart, siteEnd } = getSiteLocalRepairBounds('2026-07-03', '2026-07-04', 'America/Chicago');
        const july3EveningRowUtc = new Date('2026-07-04T00:30:00.000Z'); // 19:30 CDT on July 3

        expect(july3EveningRowUtc.getTime()).toBeGreaterThanOrEqual(siteStart.getTime());
        expect(july3EveningRowUtc.getTime()).toBeLessThan(siteEnd.getTime());
    });

    it('excludes prior evening (e.g. July 2 19:00 CDT = 2026-07-03T00:00Z) from the site-local window', () => {
        const { siteStart, siteEnd } = getSiteLocalRepairBounds('2026-07-03', '2026-07-04', 'America/Chicago');
        const july2EveningRowUtc = new Date('2026-07-03T00:30:00.000Z'); // 19:30 CDT on July 2

        expect(july2EveningRowUtc.getTime()).toBeLessThan(siteStart.getTime());
    });

    it('derives site-local bounds for UTC', () => {
        const { siteStart, siteEnd } = getSiteLocalRepairBounds('2026-07-03', '2026-07-04', 'UTC');

        expect(siteStart.toISOString()).toBe('2026-07-03T00:00:00.000Z');
        expect(siteEnd.toISOString()).toBe('2026-07-04T00:00:00.000Z');
    });

    it('handles ISO timestamp string args gracefully', () => {
        const { siteStart, siteEnd } = getSiteLocalRepairBounds('2026-07-03T00:00:00Z', '2026-07-04T00:00:00Z', 'America/Chicago');

        expect(siteStart.toISOString()).toBe('2026-07-03T05:00:00.000Z');
        expect(siteEnd.toISOString()).toBe('2026-07-04T05:00:00.000Z');
    });
});
