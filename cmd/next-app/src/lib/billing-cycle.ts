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
 * Short-month behavior (e.g. billingStartDay=31 in February) relies on
 * Temporal.PlainDate.from's default overflow: 'constrain', which clamps the
 * day to the month's last day (Feb 31 → Feb 28/29) — the desired billing
 * semantics for cycles anchored past a month's end.
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

// Determine which month contains the billing cycle start. Compare against
    // the anchor clamped to this month's length: in a 30-day month a day-31
    // anchor starts the cycle on the 30th, so the 30th belongs to the new
    // cycle, not the previous month's.
    const clampedDay = Math.min(day, zonedNow.daysInMonth);
    let cycleMonth = zonedNow.month;
    let cycleYear = zonedNow.year;
    if (zonedNow.day < clampedDay) {
        cycleMonth -= 1;
        if (cycleMonth < 1) {
            cycleMonth = 12;
            cycleYear -= 1;
        }
    }

    // Construct the billing day and convert to site-local midnight via the centralized getSiteLocalDate.
    return getSiteLocalDate(cycleYear, cycleMonth, day, timeZone);
}
