import { after, NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, flushLogEvents, observeRoute, setLogContext } from '@/lib/observability';
import { PublicPlansIneligibleError, publicPlansIneligiblePayload } from '@/lib/rate-plan-eligibility';
import { isCrossOriginRequest } from '@/lib/request-security';
import { jsonWithETag } from '@/lib/tariff-etag';
import { REATTRIBUTION_AFTER_MAX_TIME_MS, runSiteReattribution } from '@/lib/tariff-reattribution';
import { commitTariffSelection } from '@/lib/tariff-selection-service';
import { TariffValidationError } from '@/lib/tariff-timeline';
import {
  TariffNotFoundError,
  TariffSelectionConflictError,
  UtilityChangedError,
} from '@/lib/tariff-timeline-repo';
import { UrdbUnavailableError } from '@/lib/urdb/client';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/selection', async () => {
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
      const committed = await withIoDeadline(30_000, () =>
        commitTariffSelection(siteId, user.id, body)
      );
      if (!committed.unchanged && committed.reattributionRange !== null) {
        after(async () => {
          try {
            await withIoDeadline(10_000, () =>
              runSiteReattribution({ siteId, trigger: 'after', maxTimeMs: REATTRIBUTION_AFTER_MAX_TIME_MS })
            );
          } finally {
            flushLogEvents();
          }
        });
      }
      return jsonWithETag(committed, 200);
    } catch (error) {
      if (error instanceof TariffSelectionConflictError) {
        return json(
          {
            error: error.message,
            code: error.code,
            refreshPath: error.refreshPath,
            preview: error.preview,
          },
          409
        );
      }
      if (error instanceof PublicPlansIneligibleError) {
        return json(publicPlansIneligiblePayload(error), 409);
      }
      if (error instanceof UtilityChangedError) return json({ error: error.message }, 409);
      if (error instanceof UrdbUnavailableError || error instanceof IoDeadlineError) {
        return json({ error: 'Utility rates are unavailable right now.' }, 503);
      }
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not save rate plan selection.', ...errorFields(error) }, 500);
    }
  })(req);
}
