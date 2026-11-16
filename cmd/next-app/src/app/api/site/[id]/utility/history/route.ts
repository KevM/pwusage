import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { siteLocalDateString, TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';
import * as urdb from '@/lib/urdb/client';
import { memoisedApi } from '@/lib/urdb/memoised-api';
import { buildRatePlanHistory } from '@/lib/urdb/history-candidates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/utility/history', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    try {
      const repo = new TariffTimelineRepo();
      const site = await repo.getSiteUtilityContext(siteId);
      if (!site) throw new TariffNotFoundError('Site not found');
      const utilityName = site.name;
      if (!utilityName) return json({ error: 'Choose a utility first.' }, 409);
      const today = siteLocalDateString(new Date(), site.timezone);
      const { window, tesla } = await repo.getRatePlanHistoryInputs(siteId, today);
      if (!window) return json({ error: 'Your rate plan history is already filled.' }, 409);
      const api = memoisedApi();
      return json(await withIoDeadline(45_000, () => buildRatePlanHistory({ api, utilityName, timeZone: site.timezone, today, window, tesla })));
    } catch (error) {
      if (error instanceof urdb.UrdbUnavailableError || error instanceof IoDeadlineError) return json({ error: 'Utility rates are unavailable right now.' }, 503);
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not load rate plan history.', ...errorFields(error) }, 500);
    }
  })(req);
}
