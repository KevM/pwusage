import { Temporal } from '@js-temporal/polyfill';

/**
 * Converts a site-local date (year, month, day) to a UTC instant at
 * site-local midnight. Used to parse query parameters that represent
 * site-local dates (e.g. "2024-05-01") into UTC timestamps for database queries.
 *
 * For a site in Sydney (UTC+11), passing (2024, 5, 1) returns the UTC instant
 * for April 30, 2024 at 13:00 UTC (which is May 1, 2024 at 00:00 in Sydney).
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
 * Given a UTC instant, add or subtract months in the site's timezone and return
 * the new UTC instant. Used to calculate previous/next month navigation links.
 *
 * For a site in Sydney, if date is April 30 UTC 13:00 (May 1 Sydney local),
 * addMonths(date, 1, tz) returns May 30 UTC 13:00 (June 1 Sydney local).
 */
export function addMonthsInSiteTimezone(
    date: Date,
    months: number,
    timeZone: string
): Date {
    // Convert UTC instant to site-local date components
    const instant = Temporal.Instant.from(date.toISOString());
    const zoned = instant.toZonedDateTimeISO(timeZone);

    // Add months and get new date
    const newZoned = zoned.add({ months });

    // Convert back to UTC instant
    return new Date(newZoned.toInstant().toString());
}

/**
 * Returns the start of the current billing cycle for a site, given the
 * configured day-of-month the cycle resets, the current time, and the site's
 * IANA timezone (e.g. 'America/Los_Angeles').
 *
 * The result is the UTC instant corresponding to site-local midnight on the
 * cycle-start day. This matters near the billing-day boundary in non-UTC
 * zones, where server-local Date math (UTC on Vercel) would otherwise place
 * the cycle window hours away from where the user perceives it.
 *
 * Short-month behavior (e.g. billingStartDay=31 in February) is preserved
 * via Temporal Date overflow — no clamping.
 */
export function getCurrentCycleStart(
    billingStartDay: number,
    now: Date,
    timeZone: string
): Date {
    const day = billingStartDay || 1;

    // Get site-local date components via Temporal.
    const instant = Temporal.Instant.from(now.toISOString());
    const zonedNow = instant.toZonedDateTimeISO(timeZone);

    // Determine which month contains the billing cycle start.
    let cycleMonth = zonedNow.month;
    let cycleYear = zonedNow.year;
    if (zonedNow.day < day) {
        cycleMonth -= 1;
        if (cycleMonth < 1) {
            cycleMonth = 12;
            cycleYear -= 1;
        }
    }

    // Construct the billing day as a plain date, then convert to site-local midnight.
    // Temporal handles all timezones correctly, including UTC+12+.
    const billingDate = Temporal.PlainDate.from({
        year: cycleYear,
        month: cycleMonth,
        day
    });

    // Convert to zoned datetime at midnight in the site timezone.
    const midnight = billingDate.toZonedDateTime({
        timeZone,
        plainTime: Temporal.PlainTime.from('00:00:00')
    });

    // Convert the zoned instant back to a JavaScript Date.
    return new Date(midnight.toInstant().toString());
}
