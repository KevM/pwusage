import { Temporal } from '@js-temporal/polyfill';
import { getSiteLocalDate } from './date-utils';

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

    // Construct the billing day and convert to site-local midnight via the centralized getSiteLocalDate.
    return getSiteLocalDate(cycleYear, cycleMonth, day, timeZone);
}
