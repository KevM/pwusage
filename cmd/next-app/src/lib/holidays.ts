/**
 * Data-driven utility-holiday calendar for TOU schedule resolution.
 *
 * Utilities bill designated holidays at weekend/off-peak rates. When a fixed
 * holiday falls on a weekend it is *observed* on the adjacent weekday
 * (Saturday -> preceding Friday, Sunday -> following Monday), and that
 * observed day gets holiday rates. Holidays are data, not code, so a
 * per-utility calendar can be swapped in later via the `rules` parameter.
 */

export type HolidayRule =
    | {
        kind: 'fixed';
        month: number; // 1-12
        day: number;   // 1-31
        /** Shift observance to Friday/Monday when the date falls on Sat/Sun. */
        shiftWeekendObservance: boolean;
    }
    | {
        kind: 'nth-weekday';
        month: number;   // 1-12
        weekday: number; // 0=Sun ... 6=Sat (JS Date convention)
        nth: number;     // 1-4, or -1 for the last occurrence in the month
    };

/** The standard six US utility TOU holidays (e.g. We Energies). */
export const US_TOU_HOLIDAYS: HolidayRule[] = [
    { kind: 'fixed', month: 1, day: 1, shiftWeekendObservance: true },    // New Year's Day
    { kind: 'nth-weekday', month: 5, weekday: 1, nth: -1 },               // Memorial Day
    { kind: 'fixed', month: 7, day: 4, shiftWeekendObservance: true },    // Independence Day
    { kind: 'nth-weekday', month: 9, weekday: 1, nth: 1 },                // Labor Day
    { kind: 'nth-weekday', month: 11, weekday: 4, nth: 4 },               // Thanksgiving
    { kind: 'fixed', month: 12, day: 25, shiftWeekendObservance: true },  // Christmas
];

const DAY_MS = 24 * 60 * 60 * 1000;

// The calendar weekday of a calendar date is timezone-independent; UTC
// arithmetic makes month/year wrap (Dec 31 <-> Jan 1) fall out for free.
function utcMs(year: number, month: number, day: number): number {
    return Date.UTC(year, month - 1, day);
}

function matchesFixedDate(ms: number, rule: { month: number; day: number }): boolean {
    const d = new Date(ms);
    return d.getUTCMonth() + 1 === rule.month && d.getUTCDate() === rule.day;
}

/**
 * True when the site-local calendar date (year, month, day) should be billed
 * as a holiday: either an actual holiday, or the observed weekday for a fixed
 * holiday that falls on the adjacent weekend day.
 */
export function isObservedHoliday(
    year: number,
    month: number,
    day: number,
    rules: HolidayRule[] = US_TOU_HOLIDAYS
): boolean {
    const ms = utcMs(year, month, day);
    const weekday = new Date(ms).getUTCDay();

    for (const rule of rules) {
        if (rule.kind === 'fixed') {
            if (matchesFixedDate(ms, rule)) return true;
            if (rule.shiftWeekendObservance) {
                // Friday observing a Saturday holiday (incl. Dec 31 for a Sat Jan 1).
                if (weekday === 5 && matchesFixedDate(ms + DAY_MS, rule)
                    && new Date(ms + DAY_MS).getUTCDay() === 6) return true;
                // Monday observing a Sunday holiday.
                if (weekday === 1 && matchesFixedDate(ms - DAY_MS, rule)
                    && new Date(ms - DAY_MS).getUTCDay() === 0) return true;
            }
        } else {
            if (month !== rule.month || weekday !== rule.weekday) continue;
            if (rule.nth === -1) {
                // Last occurrence: no same-weekday date remains in the month.
                const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
                if (day + 7 > daysInMonth) return true;
            } else if (Math.ceil(day / 7) === rule.nth) {
                return true;
            }
        }
    }
    return false;
}
