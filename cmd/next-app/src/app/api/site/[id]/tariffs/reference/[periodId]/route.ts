import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import { jsonWithETag } from '@/lib/tariff-etag';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

function parsePeriodId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function PATCH(req: NextRequest, context: { params: Promise<{ id: string; periodId: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/reference/[periodId]', async () => {
    if (isCrossOriginRequest(req)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    const { id: siteId, periodId: rawPeriodId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const periodId = parsePeriodId(rawPeriodId);
    if (periodId === null) {
      return json({ error: 'Invalid rate plan period id' }, 400);
    }
    try {
      const body = await req.json();
      const timeline = await new TariffTimelineRepo().updateReferencePeriod(siteId, user.id, periodId, body);
      return jsonWithETag(timeline);
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not update reference rate plan.', ...errorFields(error) }, 500);
    }
  })(req);
}

export function DELETE(req: NextRequest, context: { params: Promise<{ id: string; periodId: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/reference/[periodId]', async () => {
    if (isCrossOriginRequest(req)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    const { id: siteId, periodId: rawPeriodId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    const periodId = parsePeriodId(rawPeriodId);
    if (periodId === null) {
      return json({ error: 'Invalid rate plan period id' }, 400);
    }
    try {
      const timeline = await new TariffTimelineRepo().deleteReferencePeriod(siteId, periodId, user.id);
      return jsonWithETag(timeline);
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not delete reference rate plan.', ...errorFields(error) }, 500);
    }
  })(req);
}
