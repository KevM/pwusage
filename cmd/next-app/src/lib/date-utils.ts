import { Temporal } from '@js-temporal/polyfill';

/**
 * Timezone-aware date utilities built on the Temporal polyfill.
 */

// Cache of validated, valid timezone strings.
const VALID_TIMEZONE_CACHE = new Set<string>(['UTC']);

/**
 * Helper to check if a timezone is valid, falling back to 'UTC' if not.
 * Logs an error to console on invalid timezone configuration.
 * Memoized to avoid per-call validation overhead.
 */
function getValidTimezone(tz: string): string {
    if (!tz) {
        return 'UTC';
    }
    if (VALID_TIMEZONE_CACHE.has(tz)) {
        return tz;
    }
    try {
        Temporal.Now.instant().toZonedDateTimeISO(tz);
        VALID_TIMEZONE_CACHE.add(tz);
        return tz;
    } catch (e) {
        console.error(`[date-utils] Invalid timezone configuration: "${tz}". Falling back to UTC.`, e);
        return 'UTC';
    }
}

/**
 * Helper to convert a Temporal PlainDate to a JS Date object at site-local midnight.
 */
function toMidnightZoned(plainDate: Temporal.PlainDate, tz: string): Date {
    const useTz = getValidTimezone(tz);
    const midnight = plainDate.toZonedDateTime({
        timeZone: useTz,
        plainTime: '00:00:00'
    });
    return new Date(midnight.toInstant().epochMilliseconds);
}

/**
 * Helper to get site-timezone midnight as a global Date object (UTC timestamp)
 * for any given input Date.
 */
export function getSiteMidnight(d: Date, tz: string): Date {
    if (isNaN(d.getTime())) {
        console.error(`[getSiteMidnight] Invalid Date received`);
        return new Date();
    }
    return parseSiteLocalDateToMidnight(formatSiteDate(d, tz), tz);
}

/**
 * Returns today's date string (e.g. "2024-05-01") in the site's local timezone.
 */
export function getSiteTodayDateStr(tz: string): string {
    return formatSiteDate(new Date(), tz);
}

/**
 * Returns today's midnight in the site's local timezone as a UTC Date object.
 */
export function getSiteTodayMidnight(tz: string): Date {
    return parseSiteLocalDateToMidnight(getSiteTodayDateStr(tz), tz);
}

/**
 * Parses a "YYYY-MM-DD" string as midnight in the site's local timezone and returns a UTC Date object.
 * Note: Throws on malformed/invalid date inputs, but invalid timezones are silently logged and fall back to UTC.
 */
export function parseSiteLocalDateToMidnight(dateStr: string, tz: string): Date {
    const plainDate = Temporal.PlainDate.from(dateStr);
    return toMidnightZoned(plainDate, tz);
}

/**
 * Safely parses a "YYYY-MM-DD" string as midnight in the site's local timezone.
 * Returns null if the date string is malformed, invalid, or null/undefined.
 */
export function safeParseSiteLocalDateToMidnight(
    dateStr: string | null | undefined,
    tz: string
): Date | null {
    if (!dateStr) return null;
    try {
        return parseSiteLocalDateToMidnight(dateStr, tz);
    } catch {
        return null;
    }
}

/**
 * Converts a site-local date (year, month, day) to a UTC instant at site-local midnight.
 */
export function getSiteLocalDate(
    year: number,
    month: number,
    day: number,
    timeZone: string
): Date {
    const plainDate = Temporal.PlainDate.from({ year, month, day });
    return toMidnightZoned(plainDate, timeZone);
}

/**
 * Given a UTC instant, add or subtract months in the site's timezone and return the new UTC instant.
 */
export function addMonthsInSiteTimezone(
    date: Date,
    months: number,
    timeZone: string
): Date {
    const useTz = getValidTimezone(timeZone);
    const instant = Temporal.Instant.from(date.toISOString());
    const zoned = instant.toZonedDateTimeISO(useTz);
    const newZoned = zoned.add({ months });
    return new Date(newZoned.toInstant().epochMilliseconds);
}

/**
 * Given a UTC instant, add or subtract days in the site's timezone and return the new UTC instant.
 */
export function addDaysInSiteTimezone(
    date: Date,
    days: number,
    timeZone: string
): Date {
    const useTz = getValidTimezone(timeZone);
    const instant = Temporal.Instant.from(date.toISOString());
    const zoned = instant.toZonedDateTimeISO(useTz);
    const newZoned = zoned.add({ days });
    return new Date(newZoned.toInstant().epochMilliseconds);
}

/**
 * Extracts site-local year, month, and day components from a UTC Date.
 */
export function getSiteLocalComponents(
    utcDate: Date,
    timeZone: string
): { year: number; month: number; day: number } {
    const useTz = getValidTimezone(timeZone);
    const instant = Temporal.Instant.from(utcDate.toISOString());
    const zoned = instant.toZonedDateTimeISO(useTz);
    return {
        year: zoned.year,
        month: zoned.month,
        day: zoned.day
    };
}

/**
 * Formats a UTC Date to a "YYYY-MM-DD" string in the site's local timezone.
 */
export function formatSiteDate(utcDate: Date, timeZone: string): string {
    const { year, month, day } = getSiteLocalComponents(utcDate, timeZone);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
