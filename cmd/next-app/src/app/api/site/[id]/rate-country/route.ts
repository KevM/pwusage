import { after, NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, flushLogEvents, observeRoute, setLogContext } from '@/lib/observability';
import { validateSiteRateCountryInput } from '@/lib/rate-plan-eligibility';
import { isCrossOriginRequest } from '@/lib/request-security';
import { jsonWithETag } from '@/lib/tariff-etag';
import { REATTRIBUTION_AFTER_MAX_TIME_MS, runSiteReattribution } from '@/lib/tariff-reattribution';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';
import { startPendingEstimates } from '@/lib/urdb/start-estimates';

export const dynamic = 'force-dynamic';
// The background estimate can run for up to 40 seconds after the response.
export const maxDuration = 60;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/rate-country', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    try {
      const rateCountry = await withIoDeadline(10_000, () =>
        new TariffTimelineRepo().getSiteRateCountry(siteId)
      );
      return json(rateCountry, 200);
    } catch (error) {
      if (error instanceof IoDeadlineError) {
        return json({ error: 'Rate country lookup timed out.' }, 503);
      }
      if (error instanceof TariffNotFoundError) {
        return json({ error: error.message }, 404);
      }
      return json({ error: 'Could not load site rate country.', ...errorFields(error) }, 500);
    }
  })(req);
}

export function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/rate-country', async () => {
    if (isCrossOriginRequest(req)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid request body.' }, 400);
    }
    try {
      const validated = validateSiteRateCountryInput(body);
      const result = await withIoDeadline(15_000, () =>
        new TariffTimelineRepo().setSiteRateCountry(siteId, user.id, validated)
      );
      if (result.reattributionRange !== null) {
        after(async () => {
          try {
            await withIoDeadline(10_000, () =>
              runSiteReattribution({
                siteId,
                trigger: 'after',
                maxTimeMs: REATTRIBUTION_AFTER_MAX_TIME_MS,
              })
            );
          } finally {
            flushLogEvents();
          }
        });
      }
      startPendingEstimates(siteId, result.timeline);
      return jsonWithETag(result.timeline, 200);
    } catch (error) {
      if (error instanceof TariffValidationError) {
        return json({ error: error.message }, 400);
      }
      if (error instanceof TariffNotFoundError) {
        return json({ error: error.message }, 404);
      }
      if (error instanceof IoDeadlineError) {
        return json({ error: 'Could not save site rate country right now.' }, 503);
      }
      return json({ error: 'Could not save site rate country.', ...errorFields(error) }, 500);
    }
  })(req);
}
