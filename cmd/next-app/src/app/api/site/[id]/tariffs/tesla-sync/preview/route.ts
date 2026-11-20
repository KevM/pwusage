import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import { previewTeslaSync, TeslaSyncUnavailableError } from '@/lib/tesla-tariff-sync-service';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/tesla-sync/preview', async () => {
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
      const preview = await withIoDeadline(30_000, () => previewTeslaSync(siteId, user.id));
      return json(preview, 200);
    } catch (error) {
      if (error instanceof TeslaSyncUnavailableError) {
        return json({ error: 'unavailable', reason: error.reason, message: error.message }, 409);
      }
      return json({ error: 'Could not preview Sync to Tesla.', ...errorFields(error) }, 500);
    }
  })(req);
}
