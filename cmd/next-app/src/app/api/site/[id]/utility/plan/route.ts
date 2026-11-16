import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import { jsonWithETag } from '@/lib/tariff-etag';
import { siteLocalDateString, TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo, UtilityChangedError } from '@/lib/tariff-timeline-repo';
import { ratesEffectiveOn, UrdbUnavailableError } from '@/lib/urdb/client';
import { urdbRateToSeasons } from '@/lib/urdb/convert';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/utility/plan', async () => {
    if (isCrossOriginRequest(req)) return json({ error: 'Cross-origin requests are not allowed' }, 403);
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    try {
      let body: unknown;
      try { body = await req.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request body.' }, 400);
      const input = body as Record<string, unknown>;
      if (Object.keys(input).length !== 1 || typeof input.label !== 'string' || !input.label) {
        return json({ error: 'Choose a valid plan.' }, 400);
      }
      const repo = new TariffTimelineRepo();
      const site = await repo.getSiteUtilityContext(siteId);
      if (!site) throw new TariffNotFoundError('Site not found');
      const utility = site.name;
      if (!utility) return json({ error: 'Choose a utility first.' }, 409);
      const today = siteLocalDateString(new Date(), site.timezone);
      const rates = await withIoDeadline(30_000, () => ratesEffectiveOn(utility, today, site.timezone));
      const plans = rates.filter(rate => rate.startdate !== undefined && Number.isFinite(rate.startdate) &&
        Number.isFinite(new Date(rate.startdate * 1000).getTime()) &&
        urdbRateToSeasons(rate, { medianMonthlyKwh: null, fallbackSellRate: 0 }).ok);
      if (!plans.some(rate => rate.label === input.label)) return json({ error: 'Choose a valid plan.' }, 400);
      return jsonWithETag(await repo.setSitePlanLabel(siteId, user.id, input.label, utility));
    } catch (error) {
      if (error instanceof UrdbUnavailableError || error instanceof IoDeadlineError) return json({ error: 'Utility rates are unavailable right now.' }, 503);
      if (error instanceof UtilityChangedError) return json({ error: 'Utility changed. Choose a plan again.' }, 409);
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not load utility plans.', ...errorFields(error) }, 500);
    }
  })(req);
}
