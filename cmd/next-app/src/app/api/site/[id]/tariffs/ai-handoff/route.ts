import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { buildRatePlanAiHandoffMarkdown } from '@/lib/tariff-ai-handoff';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/ai-handoff', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    try {
      const timeline = await new TariffTimelineRepo().getTimeline(siteId, user.id);
      const markdown = buildRatePlanAiHandoffMarkdown(timeline);
      return json({ markdown, filename: 'pwusage-rate-plan-check.md' }, 200);
    } catch (error) {
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not export rate plans.', ...errorFields(error) }, 500);
    }
  })(req);
}
