import type { ParsedSeason, ParsedSchedule } from '../importer/tariff-parser';

export interface Cell { weekday: number; hour: number }   // weekday: Tesla 0=Mon … 6=Sun
export interface WindowCoverage { grid: boolean[][]; gaps: Cell[] }  // grid[weekday][hour] = covered?
export interface CalendarGap { month: number; day: number; count: number }  // count 0 = gap, >1 = overlap

const EPS = 1e-9;
const isAllDay = (s: ParsedSchedule) => s.from_hour === 0 && s.to_hour === 24;
const dayRange = (s: ParsedSchedule) => s.to_day_of_week - s.from_day_of_week;

function sortSchedules(schedules: ParsedSchedule[]): ParsedSchedule[] {
    return [...schedules].sort((a, b) => {
        if (dayRange(a) !== dayRange(b)) return dayRange(a) - dayRange(b);
        const aSpecific = !isAllDay(a), bSpecific = !isAllDay(b);
        if (aSpecific && !bSpecific) return -1;
        if (!aSpecific && bSpecific) return 1;
        return 0;
    });
}

function matchDay(twd: number, s: ParsedSchedule): boolean {
    return twd >= s.from_day_of_week && twd <= s.to_day_of_week;
}
function matchHour(hour: number, s: ParsedSchedule): boolean {
    if (s.from_hour <= s.to_hour) return hour >= s.from_hour && hour < s.to_hour;
    return hour >= s.from_hour || hour < s.to_hour;   // midnight-crossing
}

/** The 7×24 (Tesla-weekday × hour) coverage grid for one season + the list of gap cells. */
export function windowCoverage(season: ParsedSeason): WindowCoverage {
    const sorted = sortSchedules(season.schedules);
    const grid: boolean[][] = [];
    const gaps: Cell[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
        const row: boolean[] = [];
        for (let hour = 0; hour < 24; hour++) {
            const covered = sorted.some(s => matchDay(weekday, s) && matchHour(hour, s));
            row.push(covered);
            if (!covered) gaps.push({ weekday, hour });
        }
        grid.push(row);
    }
    return { grid, gaps };
}

/** Mirrors schedule.ts matchSeason (inclusive bounds; wrap-around year). */
function matchSeason(month: number, day: number, s: ParsedSeason): boolean {
    const wraps = s.to_month < s.from_month;
    if (!wraps) {
        if (s.from_month === s.to_month) return month === s.from_month && day >= s.from_day && day <= s.to_day;
        if (month > s.from_month && month < s.to_month) return true;
        if (month === s.from_month && day >= s.from_day) return true;
        if (month === s.to_month && day <= s.to_day) return true;
        return false;
    }
    if (month > s.from_month || month < s.to_month) return true;
    if (month === s.from_month && day >= s.from_day) return true;
    if (month === s.to_month && day <= s.to_day) return true;
    return false;
}

/** Days of a leap reference year matched by zero seasons (gap) or more than one (overlap). */
export function seasonCalendarGaps(seasons: ParsedSeason[]): CalendarGap[] {
    const out: CalendarGap[] = [];
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // 2024 (leap)
    for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= daysInMonth[month - 1]; day++) {
            const count = seasons.filter(s => matchSeason(month, day, s)).length;
            if (count !== 1) out.push({ month, day, count });
        }
    }
    return out;
}

/** Collapse each season whose windows all share one (buy,sell) rate into a single
 *  24/7 all-week window (decision 9). Genuinely differing seasons pass through. */
export function canonicalizeSeasons(seasons: ParsedSeason[]): ParsedSeason[] {
    return seasons.map(s => {
        const first = s.schedules[0];
        const uniform = first && s.schedules.every(w =>
            Math.abs(w.buy_rate - first.buy_rate) < EPS && Math.abs(w.sell_rate - first.sell_rate) < EPS);
        if (!uniform) return s;
        return {
            ...s,
            buy_rate: first.buy_rate,
            sell_rate: first.sell_rate,
            schedules: [{
                name: 'Flat', buy_rate: first.buy_rate, sell_rate: first.sell_rate,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
            }],
        };
    });
}

/** Rate-based Fixed/TOU (mirrors classifyTariff): Fixed iff every window buy rate is equal. */
export function isFixedSchedule(seasons: ParsedSeason[]): boolean {
    const rates: number[] = [];
    for (const s of seasons) for (const w of s.schedules) rates.push(w.buy_rate);
    if (rates.length === 0) return true;
    return rates.every(r => Math.abs(r - rates[0]) < EPS);
}

/** True when a structure is not fully covered: any calendar day matched by ≠1 season,
 *  or any (weekday, hour) left unresolved in any season. Mirrors the server's coverage
 *  check (route `coverageError`); the editor disables Save while this is true. */
export function scheduleHasGaps(seasons: ParsedSeason[]): boolean {
    if (seasons.length === 0) return true;
    if (seasonCalendarGaps(seasons).length > 0) return true;
    return seasons.some(s => windowCoverage(s).gaps.length > 0);
}

/** First human-readable coverage problem in a structure, or null when fully covered.
 *  Shared by the comparison and metered tariff routes. */
export function coverageError(seasons: ParsedSeason[]): string | null {
    if (!Array.isArray(seasons) || seasons.length === 0) return 'At least one season is required.';
    const calGaps = seasonCalendarGaps(seasons);
    if (calGaps.length > 0) {
        const g = calGaps[0];
        return g.count === 0
            ? `No season covers ${g.month}/${g.day} — every day of the year must belong to a season.`
            : `${g.month}/${g.day} is covered by ${g.count} seasons — seasons must not overlap.`;
    }
    for (const s of seasons) {
        const { gaps } = windowCoverage(s);
        if (gaps.length > 0) {
            const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            const c = gaps[0];
            return `Season "${s.name}" leaves ${days[c.weekday]} ${String(c.hour).padStart(2, '0')}:00 unpriced — every hour must be covered by a window.`;
        }
    }
    return null;
}

