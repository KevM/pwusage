import { after, NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { pool } from '@/lib/db';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, flushLogEvents, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import {
  enqueueTariffReattribution,
  REATTRIBUTION_AFTER_MAX_TIME_MS,
  runSiteReattribution,
} from '@/lib/tariff-reattribution';
import { TariffValidationError, siteLocalDateString, validateEffectiveDates } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/reattribute', async () => {
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
      let body: { fromDate?: string; toDate?: string | null } = {};
      try {
        body = (await req.json()) as { fromDate?: string; toDate?: string | null };
      } catch {
        // Optional body for retry requests
      }

      const siteRes = await pool.query<{ timezone: string }>('SELECT timezone FROM "Site" WHERE id = $1', [siteId]);
      if (!siteRes.rows[0]) {
        throw new TariffNotFoundError('Site not found');
      }
      const today = siteLocalDateString(new Date(), siteRes.rows[0].timezone || 'UTC');

      let fromDate = body.fromDate;
      let toDate = body.toDate ?? null;
      if (fromDate) {
        validateEffectiveDates(fromDate, toDate, today);
      } else {
        const existingRes = await pool.query<{ from_date: string; to_date: string | null }>(
          'SELECT from_date::text, to_date::text FROM "SiteTariffReattribution" WHERE site_id = $1',
          [siteId]
        );
        fromDate = existingRes.rows[0]?.from_date ?? '2015-01-01';
        toDate = existingRes.rows[0]?.to_date ?? null;
      }

      const reattribution = await enqueueTariffReattribution({
        siteId,
        fromDate,
        toDate,
        requestedByUserId: user.id,
        trigger: 'retry',
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
      const timeline = await new TariffTimelineRepo().getTimeline(siteId, user.id);
      return json({ ...timeline, reattribution });
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not start historical recalculation.', ...errorFields(error) }, 500);
    }
  })(req);
}
