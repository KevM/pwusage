import { describe, it, expect } from 'vitest';
import {
    getSiteMidnight,
    getSiteTodayDateStr,
    getSiteTodayMidnight,
    parseSiteLocalDateToMidnight,
    safeParseSiteLocalDateToMidnight,
    getSiteLocalDate,
    addMonthsInSiteTimezone,
    addDaysInSiteTimezone,
    getSiteLocalComponents,
    formatSiteDate
} from './date-utils';

describe('getSiteMidnight', () => {
    const tz = 'America/Los_Angeles';

    it('returns local midnight on a standard non-transition day', () => {
        // July 1, 2026 12:00:00 PDT = 19:00:00 UTC
        const d = new Date('2026-07-01T19:00:00Z');
        const midnight = getSiteMidnight(d, tz);
        // Midnight PDT on July 1, 2026 is 07:00:00 UTC (offset is -7h)
        expect(midnight.toISOString()).toBe('2026-07-01T07:00:00.000Z');
    });

    it('returns correct local midnight on spring-forward transition day', () => {
        // March 8, 2026 is DST Spring Forward in LA.
        // Local midnight is March 8, 00:00:00 PST (offset is -8h) -> 08:00:00 UTC.
        // Query time is March 8, 12:00:00 PDT (offset is -7h) -> 19:00:00 UTC.
        const d = new Date('2026-03-08T19:00:00Z');
        const midnight = getSiteMidnight(d, tz);
        expect(midnight.toISOString()).toBe('2026-03-08T08:00:00.000Z');
    });

    it('returns correct local midnight on fall-back transition day', () => {
        // November 1, 2026 is DST Fall Back in LA.
        // Local midnight is Nov 1, 00:00:00 PDT (offset is -7h) -> 07:00:00 UTC.
        // Query time is Nov 1, 12:00:00 PST (offset is -8h) -> 20:00:00 UTC.
        const d = new Date('2026-11-01T20:00:00Z');
        const midnight = getSiteMidnight(d, tz);
        expect(midnight.toISOString()).toBe('2026-11-01T07:00:00.000Z');
    });
});

describe('new centralized date-utils', () => {
    const tz = 'America/Los_Angeles';

    it('parseSiteLocalDateToMidnight parses YYYY-MM-DD correctly', () => {
        const midnight = parseSiteLocalDateToMidnight('2026-07-02', tz);
        // Midnight PDT on July 2, 2026 is 07:00:00 UTC
        expect(midnight.toISOString()).toBe('2026-07-02T07:00:00.000Z');
    });

    it('getSiteTodayDateStr and getSiteTodayMidnight return consistent results', () => {
        const todayStr = getSiteTodayDateStr(tz);
        const todayMidnight = getSiteTodayMidnight(tz);
        expect(todayMidnight.toISOString()).toBe(parseSiteLocalDateToMidnight(todayStr, tz).toISOString());
    });

    it('getSiteLocalDate constructs correct midnight Date', () => {
        const date = getSiteLocalDate(2026, 7, 2, tz);
        expect(date.toISOString()).toBe('2026-07-02T07:00:00.000Z');
    });

    it('addMonthsInSiteTimezone handles month addition correctly across timezone boundaries', () => {
        const base = parseSiteLocalDateToMidnight('2026-01-31', tz);
        const nextMonth = addMonthsInSiteTimezone(base, 1, tz);
        // Feb 28, 2026 at midnight PST (offset -8h) -> Feb 28, 2026 08:00:00 UTC
        expect(nextMonth.toISOString()).toBe('2026-02-28T08:00:00.000Z');
    });

    it('getSiteLocalComponents extracts components correctly', () => {
        const d = new Date('2026-07-02T05:00:00Z'); // 22:00:00 PDT on July 1
        const comps = getSiteLocalComponents(d, tz);
        expect(comps).toEqual({ year: 2026, month: 7, day: 1 });
    });

    it('formatSiteDate formats Date in site timezone correctly', () => {
        const d = new Date('2026-07-02T05:00:00Z'); // July 1 in LA
        expect(formatSiteDate(d, tz)).toBe('2026-07-01');
    });

    it('safeParseSiteLocalDateToMidnight parses valid and returns null on invalid dates', () => {
        expect(safeParseSiteLocalDateToMidnight('2026-07-02', tz)?.toISOString()).toBe('2026-07-02T07:00:00.000Z');
        expect(safeParseSiteLocalDateToMidnight('2026-02-30', tz)).toBeNull();
        expect(safeParseSiteLocalDateToMidnight('garbage', tz)).toBeNull();
        expect(safeParseSiteLocalDateToMidnight(null, tz)).toBeNull();
    });

    it('addDaysInSiteTimezone handles standard and transition additions correctly', () => {
        const base = parseSiteLocalDateToMidnight('2026-03-07', tz); // Day before spring-forward
        const nextDay = addDaysInSiteTimezone(base, 1, tz);
        expect(nextDay.toISOString()).toBe('2026-03-08T08:00:00.000Z'); // LA spring forward, midnight is 08:00 UTC
    });
});
