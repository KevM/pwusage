import { describe, it, expect } from 'vitest';
import { isObservedHoliday, US_TOU_HOLIDAYS } from './holidays';

describe('isObservedHoliday', () => {
    it('marks fixed holidays on their actual date', () => {
        expect(isObservedHoliday(2026, 1, 1)).toBe(true);   // New Year's Day (Thu)
        expect(isObservedHoliday(2026, 7, 4)).toBe(true);   // Independence Day (Sat)
        expect(isObservedHoliday(2026, 12, 25)).toBe(true); // Christmas (Fri)
    });

    it('observes a Saturday holiday on the preceding Friday (the 2026-07-03 bug)', () => {
        // Jul 4 2026 is a Saturday -> Friday Jul 3 is the observed holiday.
        expect(isObservedHoliday(2026, 7, 3)).toBe(true);
        // The Thursday before is NOT a holiday.
        expect(isObservedHoliday(2026, 7, 2)).toBe(false);
    });

    it('observes a Sunday holiday on the following Monday', () => {
        // Jul 4 2027 is a Sunday -> Monday Jul 5 2027 observed.
        expect(isObservedHoliday(2027, 7, 5)).toBe(true);
        expect(isObservedHoliday(2027, 7, 6)).toBe(false);
    });

    it('handles the cross-year shift: New Year 2028 (Saturday) observed Friday Dec 31 2027', () => {
        expect(isObservedHoliday(2027, 12, 31)).toBe(true);
        expect(isObservedHoliday(2028, 1, 1)).toBe(true); // actual date still counts
    });

    it('does not shift when the holiday falls on a weekday', () => {
        // Jul 4 2025 is a Friday: Jul 3 (Thu) and Jul 5 (Sat) are not observed.
        expect(isObservedHoliday(2025, 7, 3)).toBe(false);
        expect(isObservedHoliday(2025, 7, 5)).toBe(false);
        expect(isObservedHoliday(2025, 7, 4)).toBe(true);
    });

    it('computes floating holidays', () => {
        expect(isObservedHoliday(2026, 5, 25)).toBe(true);   // Memorial Day: last Mon of May 2026
        expect(isObservedHoliday(2026, 5, 18)).toBe(false);  // a Monday, but not the last
        expect(isObservedHoliday(2026, 9, 7)).toBe(true);    // Labor Day: first Mon of Sep 2026
        expect(isObservedHoliday(2026, 11, 26)).toBe(true);  // Thanksgiving: 4th Thu of Nov 2026
        expect(isObservedHoliday(2026, 11, 19)).toBe(false); // 3rd Thu
    });

    it('returns false for ordinary days', () => {
        expect(isObservedHoliday(2026, 3, 11)).toBe(false);
        expect(isObservedHoliday(2026, 8, 14)).toBe(false);
    });

    it('exposes the default US rule set for callers that need to customize', () => {
        expect(US_TOU_HOLIDAYS.length).toBeGreaterThanOrEqual(6);
        expect(US_TOU_HOLIDAYS).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'fixed', month: 1, day: 1 }),
                expect.objectContaining({ kind: 'fixed', month: 7, day: 4 }),
                expect.objectContaining({ kind: 'fixed', month: 12, day: 25 }),
            ])
        );
    });
});

