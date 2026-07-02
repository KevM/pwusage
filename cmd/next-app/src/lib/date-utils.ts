import { Temporal } from '@js-temporal/polyfill';

/**
 * Timezone-aware date utilities built on the Temporal polyfill.
 */

/**
 * Helper to get site-timezone midnight as a global Date object (UTC timestamp)
 * for any given input Date.
 */
export function getSiteMidnight(d: Date, tz: string): Date {
    if (isNaN(d.getTime())) {
        console.error(`[getSiteMidnight] Invalid Date received`);
        return new Date();
    }
    const instant = Temporal.Instant.from(d.toISOString());
    const zoned = instant.toZonedDateTimeISO(tz);
    const midnight = zoned.toPlainDate().toZonedDateTime({
        timeZone: tz,
        plainTime: '00:00:00'
    });
    return new Date(midnight.toInstant().epochMilliseconds);
}

/**
 * Returns today's date string (e.g. "2024-05-01") in the site's local timezone.
 */
export function getSiteTodayDateStr(tz: string): string {
    const instant = Temporal.Now.instant();
    const zoned = instant.toZonedDateTimeISO(tz);
    return zoned.toPlainDate().toString();
}

/**
 * Returns today's midnight in the site's local timezone as a UTC Date object.
 */
export function getSiteTodayMidnight(tz: string): Date {
    return parseSiteLocalDateToMidnight(getSiteTodayDateStr(tz), tz);
}

/**
 * Parses a "YYYY-MM-DD" string as midnight in the site's local timezone and returns a UTC Date object.
 */
export function parseSiteLocalDateToMidnight(dateStr: string, tz: string): Date {
    const plainDate = Temporal.PlainDate.from(dateStr);
    const midnight = plainDate.toZonedDateTime({
        timeZone: tz,
        plainTime: '00:00:00'
    });
    return new Date(midnight.toInstant().epochMilliseconds);
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
    const date = Temporal.PlainDate.from({
        year,
        month,
        day
    });

    const midnight = date.toZonedDateTime({
        timeZone,
        plainTime: Temporal.PlainTime.from('00:00:00')
    });

    return new Date(midnight.toInstant().toString());
}

/**
 * Given a UTC instant, add or subtract months in the site's timezone and return the new UTC instant.
 */
export function addMonthsInSiteTimezone(
    date: Date,
    months: number,
    timeZone: string
): Date {
    const instant = Temporal.Instant.from(date.toISOString());
    const zoned = instant.toZonedDateTimeISO(timeZone);
    const newZoned = zoned.add({ months });
    return new Date(newZoned.toInstant().toString());
}

/**
 * Extracts site-local year, month, and day components from a UTC Date.
 */
export function getSiteLocalComponents(
    utcDate: Date,
    timeZone: string
): { year: number; month: number; day: number } {
    const instant = Temporal.Instant.from(utcDate.toISOString());
    const zoned = instant.toZonedDateTimeISO(timeZone);
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
