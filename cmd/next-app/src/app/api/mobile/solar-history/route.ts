import { NextResponse } from 'next/server';
import { Temporal } from '@js-temporal/polyfill';
import { getCurrentRoles, verifySiteAccess } from '@/lib/auth-checks';
import { formatSiteDate, parseSiteLocalDateToMidnight } from '@/lib/date-utils';
import { pool } from '@/lib/db';
import { CompactHistoryStore, type SolarHistoryDay } from '@/lib/prototypes/compact-history-store';
import { withRequestContext } from '@/lib/request-context';
import { SiteRepo } from '@/lib/site-repo';
import { hasSolarForecastBeta } from '@/lib/solar-forecast-beta';

export const dynamic = 'force-dynamic';

const PRIVATE_NO_STORE = 'private, no-store, max-age=0';
/** Days per response. The read asks for one more, which reveals whether a next page exists. */
const PAGE_DAYS = 92;
const MAX_DAYS_BACK = 400;
const SLOT_MS = 300000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: { 'Cache-Control': PRIVATE_NO_STORE } });
}

/** A real calendar date written as `YYYY-MM-DD`, or null. */
function parseDay(value: string | null): Temporal.PlainDate | null {
    if (!value || !DAY_PATTERN.test(value)) return null;
    try {
        const day = Temporal.PlainDate.from(value);
        return day.toString() === value ? day : null;
    } catch {
        return null;
    }
}

function parseInstant(value: string): Date | null {
    if (!INSTANT_PATTERN.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
}

/** One slot per 5 minutes from the day start; slots without a sample on the grid stay null. */
function solarSlots(day: SolarHistoryDay): (number | null)[] {
    const slots: (number | null)[] = Array(day.expectedSlots).fill(null);
    for (const { timestamp, solarWh } of day.samples) {
        const offset = +timestamp - +day.dayStart;
        if (offset < 0 || offset % SLOT_MS !== 0 || offset / SLOT_MS >= day.expectedSlots) continue;
        slots[offset / SLOT_MS] = Math.round(solarWh * 10) / 10;
    }
    return slots;
}

function dayJson(day: SolarHistoryDay, timeZone: string) {
    return {
        day: formatSiteDate(day.dayStart, timeZone),
        dayStart: day.dayStart.toISOString(),
        status: day.status,
        fetchedAt: day.fetchedAt?.toISOString() ?? null,
        solarWh: solarSlots(day),
    };
}

/**
 * Archived solar samples for the phone's on-device layout detection. Read-only: never calls Tesla.
 * Pages by site-local day; `changedSince` keeps days fetched strictly after it.
 */
export async function GET(request: Request): Promise<NextResponse> {
    return withRequestContext(async () => {
        try {
            const params = new URL(request.url).searchParams;
            const siteId = params.get('siteId');
            if (!siteId) return json({ error: 'Missing siteId' }, 400);
            if (!(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
            if (!hasSolarForecastBeta(await getCurrentRoles())) return json({ version: 1, enabled: false });
            const site = await new SiteRepo().getSite(siteId);
            if (!site) return json({ error: 'Site not found' }, 404);
            const timeZone = site.timezone;

            const from = parseDay(params.get('from'));
            if (!from) return json({ error: 'Invalid from' }, 400);
            const changedSinceParam = params.get('changedSince');
            const changedSince = changedSinceParam === null ? null : parseInstant(changedSinceParam);
            if (changedSinceParam !== null && !changedSince) return json({ error: 'Invalid changedSince' }, 400);

            const today = Temporal.PlainDate.from(formatSiteDate(new Date(), timeZone));
            if (Temporal.PlainDate.compare(from, today.subtract({ days: MAX_DAYS_BACK })) < 0) return json({ error: 'from is more than 400 days back' }, 400);
            if (Temporal.PlainDate.compare(from, today) > 0) return json({ version: 1, enabled: true, timeZone, days: [], nextFrom: null });

            // The window runs through today's open day, which is archived as it fills.
            const start = parseSiteLocalDateToMidnight(from.toString(), timeZone);
            const end = parseSiteLocalDateToMidnight(today.add({ days: 1 }).toString(), timeZone);
            const rows = await new CompactHistoryStore(pool).readSolarDays(siteId, start, end, changedSince, PAGE_DAYS + 1);
            const days = rows.slice(0, PAGE_DAYS).map(day => dayJson(day, timeZone));
            const last = days.at(-1);
            const nextFrom = rows.length > PAGE_DAYS && last ? Temporal.PlainDate.from(last.day).add({ days: 1 }).toString() : null;
            return json({ version: 1, enabled: true, timeZone, days, nextFrom });
        } catch (error) {
            console.error('[mobile-solar-history] request failed:', error);
            return json({ error: 'Failed to fetch solar history' }, 500);
        }
    });
}
