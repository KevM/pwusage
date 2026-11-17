import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { IoDeadlineError, withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { siteLocalDateString, TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';
import { ratesEffectiveOn, UrdbUnavailableError } from '@/lib/urdb/client';
import { urdbRateToSeasons } from '@/lib/urdb/convert';
import { urdbStartDate } from '@/lib/urdb/match';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/utility/plans', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
    try {
      const repo = new TariffTimelineRepo();
      const site = await repo.getSiteUtilityContext(siteId);
      if (!site) throw new TariffNotFoundError('Site not found');
      const utility = site.name;
      if (!utility) return json({ error: 'Choose a utility first.' }, 409);
      const today = siteLocalDateString(new Date(), site.timezone);
      const rates = await withIoDeadline(30_000, () => ratesEffectiveOn(utility, today, site.timezone));
      const plans = rates.filter(rate => urdbStartDate(rate) !== null &&
        urdbRateToSeasons(rate, { medianMonthlyKwh: null, fallbackSellRate: 0 }).ok);
      return json({ plans: plans.map(rate => ({
        label: rate.label, name: rate.name,
        startDate: urdbStartDate(rate) ?? '',
      })).sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (error) {
      if (error instanceof UrdbUnavailableError || error instanceof IoDeadlineError) return json({ error: 'Utility rates are unavailable right now.' }, 503);
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not load utility plans.', ...errorFields(error) }, 500);
    }
  })(req);
}
