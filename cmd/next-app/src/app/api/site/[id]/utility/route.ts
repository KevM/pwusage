import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import {
  assertSiteContextUsEligible,
  PublicPlansIneligibleError,
  publicPlansIneligiblePayload,
} from '@/lib/rate-plan-eligibility';
import { isCrossOriginRequest } from '@/lib/request-security';
import { jsonWithETag } from '@/lib/tariff-etag';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';
import { UrdbUnavailableError, utilityNames } from '@/lib/urdb/client';
import { startPendingEstimates } from '@/lib/urdb/start-estimates';

export const dynamic = 'force-dynamic';
// The background estimate can run for up to 40 seconds after the response.
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/utility', async () => {
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
      const repo = new TariffTimelineRepo();
      let choice: { name: string } | { skipped: true };
      if (Object.keys(input).length === 1 && input.skipped === true) choice = { skipped: true };
      else if (Object.keys(input).length === 1 && typeof input.name === 'string' && input.name.length > 0) {
        const site = await repo.getSiteUtilityContext(siteId);
        if (!site) throw new TariffNotFoundError('Site not found');
        assertSiteContextUsEligible(site);
        const names = await withIoDeadline(30_000, () => utilityNames());
        if (!names.includes(input.name)) return json({ error: 'Choose a valid utility.' }, 400);
        choice = { name: input.name };
      } else return json({ error: 'Invalid request body.' }, 400);
      const timeline = await repo.setSiteUtility(siteId, user.id, choice);
      startPendingEstimates(siteId, timeline);
      return jsonWithETag(timeline);
    } catch (error) {
      if (error instanceof UrdbUnavailableError || error instanceof IoDeadlineError) return json({ error: 'Utility rates are unavailable right now.' }, 503);
      if (error instanceof PublicPlansIneligibleError) return json(publicPlansIneligiblePayload(error), 409);
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not save utility.', ...errorFields(error) }, 500);
    }
  })(req);
}
