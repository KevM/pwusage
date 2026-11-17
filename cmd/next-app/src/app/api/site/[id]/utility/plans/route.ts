import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { listPublicUtilityPlansForSite } from '@/lib/tariff-selection-service';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, UtilityChangedError } from '@/lib/tariff-timeline-repo';
import { UrdbUnavailableError } from '@/lib/urdb/client';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/utility/plans', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    try {
      const params = req.nextUrl.searchParams;
      const hasEffectiveDate = params.has('effectiveDate') || params.has('date');
      const effectiveDate = hasEffectiveDate
        ? (params.get('effectiveDate') ?? params.get('date') ?? '')
        : null;
      const response = await withIoDeadline(30_000, () =>
        listPublicUtilityPlansForSite(siteId, { effectiveDate })
      );
      return json(response);
    } catch (error) {
      if (error instanceof UrdbUnavailableError || error instanceof IoDeadlineError) {
        return json({ error: 'Utility rates are unavailable right now.' }, 503);
      }
      if (error instanceof UtilityChangedError) return json({ error: error.message }, 409);
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not load utility plans.', ...errorFields(error) }, 500);
    }
  })(req);
}
