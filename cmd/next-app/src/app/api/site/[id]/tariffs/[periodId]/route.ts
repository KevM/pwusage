import { after, NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, flushLogEvents, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import {
  REATTRIBUTION_AFTER_MAX_TIME_MS,
  runSiteReattribution,
} from '@/lib/tariff-reattribution';
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
  return observeRoute('/api/site/[id]/tariffs/[periodId]', async () => {
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
      const repo = new TariffTimelineRepo();
      // The re-attribution job is queued in the same transaction as the edit.
      const { timeline } = await repo.updatePeriod(siteId, periodId, user.id, body);
      after(async () => {
        try {
          await withIoDeadline(10_000, () =>
            runSiteReattribution({ siteId, trigger: 'after', maxTimeMs: REATTRIBUTION_AFTER_MAX_TIME_MS })
          );
        } finally {
          flushLogEvents();
        }
      });
      return json(timeline);
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not update rate plan.', ...errorFields(error) }, 500);
    }
  })(req);
}

export function DELETE(req: NextRequest, context: { params: Promise<{ id: string; periodId: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/[periodId]', async () => {
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
      const repo = new TariffTimelineRepo();
      const { timeline } = await repo.deleteManualPeriod(siteId, periodId, user.id);
      after(async () => {
        try {
          await withIoDeadline(10_000, () =>
            runSiteReattribution({ siteId, trigger: 'after', maxTimeMs: REATTRIBUTION_AFTER_MAX_TIME_MS })
          );
        } finally {
          flushLogEvents();
        }
      });
      return json(timeline);
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not delete rate plan.', ...errorFields(error) }, 500);
    }
  })(req);
}
