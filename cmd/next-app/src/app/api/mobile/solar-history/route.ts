import { NextResponse } from 'next/server';
import { Temporal } from '@js-temporal/polyfill';
import { getCurrentRoles, verifySiteAccess } from '@/lib/auth-checks';
import { formatSiteDate, parseSiteLocalDateToMidnight } from '@/lib/date-utils';
import { pool } from '@/lib/db';
import { Importer } from '@/lib/importer';
import { CompactHistoryStore, type SolarHistoryDay } from '@/lib/prototypes/compact-history-store';
import { withRequestContext } from '@/lib/request-context';
import { SiteRepo } from '@/lib/site-repo';
import { hasSolarForecastBeta } from '@/lib/solar-forecast-beta';
import { TeslaRateLimitError } from '@/lib/tesla-client';
import { createTeslaClientForSite } from '@/lib/tesla-client-factory';
import { isTeslaConnectionRequired, TeslaRefreshBackoffError } from '@/lib/tesla-refresh-outcome';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PRIVATE_NO_STORE = 'private, no-store, max-age=0';
/** Days per response. The read asks for one more, which reveals whether a next page exists. */
const PAGE_DAYS = 92;
const MAX_DAYS_BACK = 400;
/** A fill asks for at most this many complete site-local days; how far back is the caller's policy. */
const MAX_FILL_DAYS = 3;
const FILL_BUDGET = { maxWindows: MAX_FILL_DAYS, maxTimeMs: 15000 };
const SLOT_MS = 300000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
    return NextResponse.json(body, { status, headers: { 'Cache-Control': PRIVATE_NO_STORE, ...headers } });
}

/** Whole seconds until `at`, rounded up so a client never retries early. */
function retryAfterSeconds(at: number): string {
    return String(Math.max(Math.ceil((at - Date.now()) / 1000), 0));
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
 * `fetchedAt` is when the Tesla request started, not when the record committed, so writers can
 * commit out of `fetchedAt` order: clients must sync with an overlap, not from the newest `fetchedAt`.
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

/** Read a fill body: `{ siteId, from: 'YYYY-MM-DD', days: 1...3 }`, or null. */
function parseFill(body: unknown): { siteId: string; from: Temporal.PlainDate; days: number } | null {
    if (!body || typeof body !== 'object') return null;
    const { siteId, from, days } = body as Record<string, unknown>;
    if (typeof siteId !== 'string' || !siteId || typeof from !== 'string') return null;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_FILL_DAYS) return null;
    const day = parseDay(from);
    return day ? { siteId, from: day, days } : null;
}

/**
 * Fill complete site-local days `[from, from + days)` from Tesla, then return them as GET does.
 * Idempotent: stored and settled-empty days are skipped, so a client retries the same slice
 * until `status` is `complete` (`partial` ran out of budget, `busy` found another import running).
 * `historyStart` is the first day that can hold data (installation or the backfill boundary);
 * a slice wholly before it is complete without calling Tesla.
 * A Tesla throttle stops the fill and answers 529 with Tesla's `Retry-After`; days already
 * written stay written and are skipped on the retry.
 */
export async function POST(request: Request): Promise<NextResponse> {
    return withRequestContext(async () => {
        try {
            let body: unknown;
            try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
            const fill = parseFill(body);
            if (!fill) return json({ error: 'Invalid request' }, 400);
            const { siteId, from, days } = fill;
            if (!(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
            if (!hasSolarForecastBeta(await getCurrentRoles())) return json({ version: 1, enabled: false });
            const repo = new SiteRepo();
            const site = await repo.getSite(siteId);
            if (!site) return json({ error: 'Site not found' }, 404);
            const timeZone = site.timezone;

            const today = Temporal.PlainDate.from(formatSiteDate(new Date(), timeZone));
            const until = from.add({ days });
            if (Temporal.PlainDate.compare(until, today) > 0) return json({ error: 'Range must end by today' }, 400);

            const boundary = await repo.getHistoryBackfillFrom(siteId);
            const installed = Temporal.PlainDate.from(formatSiteDate(site.installed, timeZone));
            const backfillFrom = boundary ? Temporal.PlainDate.from(formatSiteDate(boundary, timeZone)) : null;
            const historyStart = backfillFrom && Temporal.PlainDate.compare(backfillFrom, installed) > 0 ? backfillFrom : installed;

            const start = parseSiteLocalDateToMidnight(from.toString(), timeZone);
            const end = parseSiteLocalDateToMidnight(until.toString(), timeZone);
            let status: 'complete' | 'partial' | 'busy' = 'complete';
            if (Temporal.PlainDate.compare(until, historyStart) > 0) {
                const client = await createTeslaClientForSite(siteId, { rateLimit: 'surface' });
                if (!client) return json({ error: 'Reconnect Tesla to update your data.', code: 'TESLA_CONNECTION_REQUIRED' }, 409);
                const importFrom = Temporal.PlainDate.compare(from, historyStart) < 0
                    ? parseSiteLocalDateToMidnight(historyStart.toString(), timeZone) : start;
                const result = await new Importer(client).ensureDataForRange(siteId, importFrom, end, undefined, FILL_BUDGET);
                // A busy lock answers 0 of 0 without completing; an empty plan is 0 of 0 complete.
                status = result.complete ? 'complete' : result.totalWindows === 0 ? 'busy' : 'partial';
            }
            const rows = await new CompactHistoryStore(pool).readSolarDays(siteId, start, end, null, days);
            return json({ version: 1, enabled: true, timeZone, status, historyStart: historyStart.toString(),
                days: rows.map(day => dayJson(day, timeZone)) });
        } catch (error) {
            if (error instanceof TeslaRateLimitError) {
                return json({ error: 'Tesla is limiting requests', code: 'TESLA_RATE_LIMITED', retryAt: error.retryAt.toISOString(),
                    retryAfterSource: error.retryAfterSource }, 529, { 'Retry-After': retryAfterSeconds(+error.retryAt) });
            }
            if (isTeslaConnectionRequired(error)) return json({ error: 'Reconnect Tesla to update your data.', code: 'TESLA_CONNECTION_REQUIRED' }, 409);
            if (error instanceof TeslaRefreshBackoffError) {
                return json({ error: error.message, code: error.code }, 503, { 'Retry-After': retryAfterSeconds(error.retryAfter) });
            }
            console.error('[mobile-solar-history] fill failed:', error);
            return json({ error: 'Failed to fill solar history' }, 500);
        }
    });
}
