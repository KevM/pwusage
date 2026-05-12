import { describe, expect, it } from 'vitest';
import { getCurrentCycleStart, getSiteLocalDate, addMonthsInSiteTimezone } from './billing-cycle';

describe('getCurrentCycleStart — UTC site', () => {
    it('returns this month at site-tz midnight when on the billing day', () => {
        const now = new Date(Date.UTC(2026, 2, 15, 12, 0, 0));
        const start = getCurrentCycleStart(15, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2026, 2, 15, 0, 0, 0)));
    });

    it('returns this month at site-tz midnight when after the billing day', () => {
        const now = new Date(Date.UTC(2026, 2, 20, 8, 0, 0));
        const start = getCurrentCycleStart(15, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2026, 2, 15, 0, 0, 0)));
    });

    it('returns previous month when before the billing day', () => {
        const now = new Date(Date.UTC(2026, 2, 10, 8, 0, 0));
        const start = getCurrentCycleStart(15, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2026, 1, 15, 0, 0, 0)));
    });

    it('handles January rollover to previous year', () => {
        const now = new Date(Date.UTC(2026, 0, 5, 8, 0, 0));
        const start = getCurrentCycleStart(15, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2025, 11, 15, 0, 0, 0)));
    });

    it('treats falsy billingStartDay as 1', () => {
        const now = new Date(Date.UTC(2026, 2, 10, 8, 0, 0));
        const start = getCurrentCycleStart(0, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2026, 2, 1, 0, 0, 0)));
    });

    it('preserves short-month overflow: billingStartDay 31 in February rolls forward', () => {
        // Feb 10 UTC, billing day 31 → site-local day 10 < 31 → cycle month = January.
        // Date.UTC(2026, 0, 31, 12, 0, 0) is January 31 noon UTC; getSiteMidnight gives Jan 31 00:00 UTC.
        const now = new Date(Date.UTC(2026, 1, 10, 12, 0, 0));
        const start = getCurrentCycleStart(31, now, 'UTC');
        expect(start).toEqual(new Date(Date.UTC(2026, 0, 31, 0, 0, 0)));
    });
});

describe('getCurrentCycleStart — America/Los_Angeles site', () => {
    // Reference: US DST starts second Sunday in March 2026 = March 8.
    // Pre-DST: PST = UTC-8. Post-DST: PDT = UTC-7.

    it('uses site-tz midnight, not UTC midnight', () => {
        // March 16 16:00 UTC = March 16 09:00 LA (PDT). After billing day 15.
        // Cycle start = March 15 LA midnight = March 15 07:00 UTC.
        const now = new Date(Date.UTC(2026, 2, 16, 16, 0, 0));
        const start = getCurrentCycleStart(15, now, 'America/Los_Angeles');
        expect(start).toEqual(new Date(Date.UTC(2026, 2, 15, 7, 0, 0)));
    });

    it('uses site-tz day boundary: late evening LA before midnight is still the same site-day', () => {
        // March 16 02:00 UTC = March 15 19:00 LA (PDT). Site-local day = 15.
        // Billing day 16 → 15 < 16 → cycle starts February 16 LA.
        // Feb is pre-DST → PST (UTC-8) → Feb 16 LA midnight = Feb 16 08:00 UTC.
        const now = new Date(Date.UTC(2026, 2, 16, 2, 0, 0));
        const start = getCurrentCycleStart(16, now, 'America/Los_Angeles');
        expect(start).toEqual(new Date(Date.UTC(2026, 1, 16, 8, 0, 0)));
    });

    it('site-tz day differs from UTC day across the dateline', () => {
        // March 15 03:00 UTC = March 14 20:00 LA (PDT). Site-local day = 14.
        // Billing day 15 → 14 < 15 → cycle starts February 15 LA.
        // Feb 15 LA midnight (PST) = Feb 15 08:00 UTC.
        const now = new Date(Date.UTC(2026, 2, 15, 3, 0, 0));
        const start = getCurrentCycleStart(15, now, 'America/Los_Angeles');
        expect(start).toEqual(new Date(Date.UTC(2026, 1, 15, 8, 0, 0)));
    });
});

describe('getCurrentCycleStart — Pacific/Auckland site (UTC+12)', () => {
    // This timezone was broken by the pivot approach: noon UTC is already the next
    // local calendar day in UTC+12. Temporal fixes this correctly.

    it('returns correct cycle start for UTC+12 timezone (billing day 1)', () => {
        // May 2 12:00 UTC = May 3 00:00 Auckland (next day!)
        // May 1 23:00 UTC = May 2 11:00 Auckland
        // Site-local day is May 2. Billing day 1 → 2 >= 1 → cycle = May 1 midnight AKL.
        // May 1 00:00 AKL = April 30 12:00 UTC.
        const now = new Date(Date.UTC(2026, 4, 1, 23, 0, 0)); // May 1 23:00 UTC
        const start = getCurrentCycleStart(1, now, 'Pacific/Auckland');
        expect(start).toEqual(new Date(Date.UTC(2026, 3, 30, 12, 0, 0))); // April 30 12:00 UTC
    });

    it('rolls back to previous month when before billing day in UTC+12', () => {
        // April 28 15:00 UTC = April 29 03:00 Auckland (UTC+12, standard time)
        // Site-local day is April 29. Billing day 1 → 29 >= 1 → cycle = April 1 midnight AKL.
        // April 1 is before DST ends (April 5), so it's NZDT (UTC+13).
        // April 1 00:00 AKL = March 31 11:00 UTC.
        const now = new Date(Date.UTC(2026, 3, 28, 15, 0, 0)); // April 28 15:00 UTC
        const start = getCurrentCycleStart(1, now, 'Pacific/Auckland');
        expect(start).toEqual(new Date(Date.UTC(2026, 2, 31, 11, 0, 0))); // March 31 11:00 UTC
    });

    it('handles month boundaries correctly in UTC+12', () => {
        // May 1 00:00 UTC = May 1 12:00 Auckland
        // Site-local day is May 1. Billing day 15 → 1 < 15 → cycle = April 15 midnight AKL.
        // April 15 00:00 AKL = April 14 12:00 UTC.
        const now = new Date(Date.UTC(2026, 4, 1, 0, 0, 0)); // May 1 00:00 UTC
        const start = getCurrentCycleStart(15, now, 'Pacific/Auckland');
        expect(start).toEqual(new Date(Date.UTC(2026, 3, 14, 12, 0, 0))); // April 14 12:00 UTC
    });
});

describe('getSiteLocalDate — converts site-local date to UTC instant', () => {
    it('returns midnight UTC for UTC timezone', () => {
        const result = getSiteLocalDate(2026, 5, 1, 'UTC');
        expect(result).toEqual(new Date(Date.UTC(2026, 4, 1, 0, 0, 0)));
    });

    it('converts site-local date to UTC instant for western timezone (UTC-8)', () => {
        // May 1 00:00 LA (PST is UTC-8) = May 1 08:00 UTC
        const result = getSiteLocalDate(2026, 5, 1, 'America/Los_Angeles');
        // During May, LA is in PDT (UTC-7), not PST (UTC-8)
        // May 1 00:00 LA (PDT, UTC-7) = May 1 07:00 UTC
        expect(result).toEqual(new Date(Date.UTC(2026, 4, 1, 7, 0, 0)));
    });

    it('converts site-local date to UTC instant for eastern timezone (UTC+10 in May)', () => {
        // May 1 00:00 Sydney (AEST, UTC+10) = April 30 14:00 UTC
        const result = getSiteLocalDate(2026, 5, 1, 'Australia/Sydney');
        expect(result).toEqual(new Date(Date.UTC(2026, 3, 30, 14, 0, 0)));
    });

    it('handles month overflow (day 31 in February constrained to Feb 28)', () => {
        // Temporal uses 'constrain' mode by default, so day 31 in Feb becomes Feb 28
        const result = getSiteLocalDate(2026, 2, 31, 'UTC');
        expect(result).toEqual(new Date(Date.UTC(2026, 1, 28, 0, 0, 0)));
    });

    it('handles UTC+12 timezone correctly', () => {
        // May 1 00:00 Auckland (UTC+12) = April 30 12:00 UTC
        const result = getSiteLocalDate(2026, 5, 1, 'Pacific/Auckland');
        expect(result).toEqual(new Date(Date.UTC(2026, 3, 30, 12, 0, 0)));
    });
});

describe('addMonthsInSiteTimezone — add months in site-local terms', () => {
    it('adds one month for UTC timezone', () => {
        const date = new Date(Date.UTC(2026, 4, 1, 0, 0, 0)); // May 1 UTC
        const result = addMonthsInSiteTimezone(date, 1, 'UTC');
        expect(result).toEqual(new Date(Date.UTC(2026, 5, 1, 0, 0, 0))); // June 1 UTC
    });

    it('subtracts one month for UTC timezone', () => {
        const date = new Date(Date.UTC(2026, 4, 1, 0, 0, 0)); // May 1 UTC
        const result = addMonthsInSiteTimezone(date, -1, 'UTC');
        expect(result).toEqual(new Date(Date.UTC(2026, 3, 1, 0, 0, 0))); // April 1 UTC
    });

    it('adds one month for eastern timezone (Sydney)', () => {
        // April 30 UTC 14:00 = May 1 00:00 Sydney (AEST, UTC+10)
        const date = new Date(Date.UTC(2026, 3, 30, 14, 0, 0));
        const result = addMonthsInSiteTimezone(date, 1, 'Australia/Sydney');
        // Result should be May 31 UTC 14:00 = June 1 00:00 Sydney
        expect(result).toEqual(new Date(Date.UTC(2026, 4, 31, 14, 0, 0)));
    });

    it('subtracts one month for eastern timezone (Sydney)', () => {
        // April 30 UTC 14:00 = May 1 00:00 Sydney (AEST, UTC+10)
        const date = new Date(Date.UTC(2026, 3, 30, 14, 0, 0));
        const result = addMonthsInSiteTimezone(date, -1, 'Australia/Sydney');
        // Subtract 1 month: April 1 00:00 Sydney (AEDT, UTC+11) = March 31 13:00 UTC
        expect(result).toEqual(new Date(Date.UTC(2026, 2, 31, 13, 0, 0)));
    });

    it('adds months across UTC+12 boundary correctly', () => {
        // April 30 UTC 12:00 = May 1 00:00 Auckland (UTC+12)
        const date = new Date(Date.UTC(2026, 3, 30, 12, 0, 0));
        const result = addMonthsInSiteTimezone(date, 1, 'Pacific/Auckland');
        // Result should be May 31 UTC 12:00 = June 1 00:00 Auckland
        expect(result).toEqual(new Date(Date.UTC(2026, 4, 31, 12, 0, 0)));
    });
});
