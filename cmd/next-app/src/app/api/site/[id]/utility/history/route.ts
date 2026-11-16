import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import { jsonWithETag } from '@/lib/tariff-etag';
import { siteLocalDateString, TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo, UtilityChangedError } from '@/lib/tariff-timeline-repo';
import * as urdb from '@/lib/urdb/client';
import { averageSell, monthlyUsage } from '@/lib/urdb/estimate-job';
import { memoisedApi } from '@/lib/urdb/memoised-api';
import { buildRatePlanHistory, mapWithConcurrency } from '@/lib/urdb/history-candidates';
import { expandHistoryPeriod, HistoryPeriodError, type HistoryPeriodInput } from '@/lib/urdb/history-expand';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/utility/history', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    try {
      const repo = new TariffTimelineRepo();
      const site = await repo.getSiteUtilityContext(siteId);
      if (!site) throw new TariffNotFoundError('Site not found');
      const utilityName = site.name;
      if (!utilityName) return json({ error: 'Choose a utility first.' }, 409);
      const today = siteLocalDateString(new Date(), site.timezone);
      const { window, tesla } = await repo.getRatePlanHistoryInputs(siteId, today);
      if (!window) return json({ error: 'Your rate plan history is already filled.' }, 409);
      const api = memoisedApi();
      return json(await withIoDeadline(45_000, () => buildRatePlanHistory({ api, utilityName, timeZone: site.timezone, today, window, tesla })));
    } catch (error) {
      if (error instanceof urdb.UrdbUnavailableError || error instanceof IoDeadlineError) return json({ error: 'Utility rates are unavailable right now.' }, 503);
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not load rate plan history.', ...errorFields(error) }, 500);
    }
  })(req);
}

const MAX_PERIODS = 12;
const isCalendarDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** The owner's periods, oldest first, or an owner-facing reason they can't be saved. */
function parseHistoryPeriods(body: unknown): HistoryPeriodInput[] | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid request body.';
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Array.isArray(input.periods)) return 'Invalid request body.';
  if (!input.periods.length) return 'Choose a rate plan.';
  if (input.periods.length > MAX_PERIODS) return `Choose at most ${MAX_PERIODS} rate plans.`;
  const periods: HistoryPeriodInput[] = [];
  for (const item of input.periods as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'Invalid request body.';
    const { label, from, to } = item as Record<string, unknown>;
    if (typeof label !== 'string' || !label || !isCalendarDate(from) || (to !== null && !isCalendarDate(to))) return 'Choose a valid rate plan and dates.';
    if (to !== null && from > to) return 'Each rate plan must end on or after its start.';
    const previous = periods.at(-1);
    if (previous && (previous.to === null || previous.to >= from)) return 'Rate plan dates can’t overlap.';
    periods.push({ label, from, to });
  }
  return periods;
}

export function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/utility/history', async () => {
    if (isCrossOriginRequest(req)) return json({ error: 'Cross-origin requests are not allowed' }, 403);
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    try {
      let body: unknown;
      try { body = await req.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
      const periods = parseHistoryPeriods(body);
      if (typeof periods === 'string') return json({ error: periods }, 400);
      const repo = new TariffTimelineRepo();
      const site = await repo.getSiteUtilityContext(siteId);
      if (!site) throw new TariffNotFoundError('Site not found');
      const utilityName = site.name;
      if (!utilityName) return json({ error: 'Choose a utility first.' }, 409);
      const now = new Date();
      const today = siteLocalDateString(now, site.timezone);
      const { window, tesla } = await repo.getRatePlanHistoryInputs(siteId, today);
      if (!window) return json({ error: 'Your rate plan history is already filled.' }, 409);
      const open = periods.at(-1)!.to === null ? periods.at(-1)! : null;
      // Tesla stays the source from the trusted start on, so only a site without Tesla versions has an open period.
      if (open && window.fillThrough !== null) return json({ error: 'Choose when each rate plan ended.' }, 400);
      const convert = { medianMonthlyKwh: await monthlyUsage(siteId, site.timezone, now), fallbackSellRate: tesla ? averageSell(tesla) : 0 };
      const api = memoisedApi();
      // The open period is checked like the others but saved as the plan pick, so its revisions are dropped.
      const expanded = await withIoDeadline(45_000, () => mapWithConcurrency(periods, 4, period =>
        expandHistoryPeriod(period, { api, utilityName, timeZone: site.timezone, today, convert })));
      const revisions = expanded.filter((_, index) => periods[index] !== open).flat();
      return jsonWithETag(await repo.saveRatePlanHistory(siteId, user.id, utilityName, revisions, open?.label ?? null));
    } catch (error) {
      if (error instanceof urdb.UrdbUnavailableError || error instanceof IoDeadlineError) return json({ error: 'Utility rates are unavailable right now.' }, 503);
      if (error instanceof UtilityChangedError) return json({ error: 'Utility changed. Start again.' }, 409);
      if (error instanceof HistoryPeriodError || error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not save rate plan history.', ...errorFields(error) }, 500);
    }
  })(req);
}
