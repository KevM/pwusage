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

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/reference', async () => {
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
      const timeline = await new TariffTimelineRepo().createReferencePeriod(siteId, user.id, body);
      return jsonWithETag(timeline, 201);
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not save reference rate plan.', ...errorFields(error) }, 500);
    }
  })(req);
}
