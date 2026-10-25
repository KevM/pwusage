import { describe, expect, it } from 'vitest';
import { TESLA_PUBLISH_LAG_MS, isDayFetchFinal, nextSampleDueAt } from './tesla-sample-timing';

const at = (iso: string) => new Date(iso);

describe('nextSampleDueAt', () => {
    it('is the next 5-minute label plus the publish lag', () => {
        expect(TESLA_PUBLISH_LAG_MS).toBe(2 * 60 * 1000);
        expect(nextSampleDueAt(at('2026-10-24T15:10:00Z'))).toEqual(at('2026-10-24T15:17:00Z'));
    });

    it('crosses midnight from yesterday\'s last label', () => {
        // Chicago 23:55 CDT is 04:55Z; the 00:00 sample is due 00:07 local.
        expect(nextSampleDueAt(at('2026-10-25T04:55:00Z'))).toEqual(at('2026-10-25T05:02:00Z'));
    });
});

describe('isDayFetchFinal', () => {
    const dayEnd = at('2026-10-25T05:00:00Z');

    it('is final once fetched after the day\'s last sample was published', () => {
        // Last label 23:55 local (04:55Z), published by 04:57Z.
        expect(isDayFetchFinal(at('2026-10-25T04:57:00Z'), dayEnd)).toBe(true);
        expect(isDayFetchFinal(at('2026-10-25T04:56:59Z'), dayEnd)).toBe(false);
    });

    it('is not final without a fetch time', () => {
        expect(isDayFetchFinal(null, dayEnd)).toBe(false);
    });
});
