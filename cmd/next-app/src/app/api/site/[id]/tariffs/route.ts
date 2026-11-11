import { after, NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, flushLogEvents, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import {
  enqueueTariffReattribution,
  REATTRIBUTION_AFTER_MAX_TIME_MS,
  runSiteReattribution,
} from '@/lib/tariff-reattribution';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    try {
      const timeline = await new TariffTimelineRepo().getTimeline(siteId, user.id);
      return json(timeline);
    } catch (error) {
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not load rate plans.', ...errorFields(error) }, 500);
    }
  })(_req);
}

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs', async () => {
    if (isCrossOriginRequest(req)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    try {
      const body = await req.json();
      const repo = new TariffTimelineRepo();
      const timeline = await repo.createManualPeriod(siteId, user.id, body);
      const reattribution = await enqueueTariffReattribution({
        siteId,
        fromDate: body.effectiveFrom,
        toDate: body.effectiveTo ?? null,
        requestedByUserId: user.id,
        trigger: 'create',
      });
      after(async () => {
        try {
          await withIoDeadline(10_000, () =>
            runSiteReattribution({ siteId, trigger: 'after', maxTimeMs: REATTRIBUTION_AFTER_MAX_TIME_MS })
          );
        } finally {
          flushLogEvents();
        }
      });
      return json({ ...timeline, reattribution }, 201);
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not save rate plan.', ...errorFields(error) }, 500);
    }
  })(req);
}
