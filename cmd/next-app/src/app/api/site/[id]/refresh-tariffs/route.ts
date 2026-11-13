import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { Importer } from '@/lib/importer';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';
import { createTeslaClientForSite } from '@/lib/tesla-client-factory';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return observeRoute('/api/site/[id]/refresh-tariffs', async () => {
    if (isCrossOriginRequest(request)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    try {
      const { id: siteId } = await params;
      setLogContext({ siteId });

      const hasAccess = await verifySiteAccess(siteId);
      if (!hasAccess) {
        return json({ error: 'Unauthorized' }, 403);
      }

      const user = await getCurrentUser();
      const repo = new TariffTimelineRepo();
      const beforeTimeline = await repo.getTimeline(siteId, user?.id ?? null);

      const client = await createTeslaClientForSite(siteId);
      if (!client) {
        return json({ error: 'Site has no Tesla credentials' }, 401);
      }

      const importer = new Importer(client);
      const updatedSite = await importer.ensureSite(siteId);
      if (!updatedSite) {
        return json({ error: 'Couldn’t refresh your rate plan from Tesla.' }, 500);
      }

      const timeline = await repo.getTimeline(siteId, user?.id ?? null);
      const updatedFromTesla =
        timeline.teslaSync.latestTariffId !== null &&
        timeline.teslaSync.latestTariffId !== beforeTimeline.teslaSync.latestTariffId;

      return json({
        success: true,
        message: 'Rate plan refreshed',
        updatedFromTesla,
        timeline,
      });
    } catch (error) {
      if (error instanceof TariffNotFoundError) {
        return json({ error: 'Site not found' }, 404);
      }
      return json({ error: 'Couldn’t refresh your rate plan from Tesla.', ...errorFields(error) }, 500);
    }
  })(request);
}
