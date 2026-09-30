import { NextResponse } from 'next/server';
import { Temporal } from '@js-temporal/polyfill';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { buildLoadPlanningContext } from '@/lib/load-planning-context';

export const dynamic = 'force-dynamic';

const PRIVATE_NO_STORE = 'private, no-store, max-age=0';
const HISTORY_DAYS = 14;

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': PRIVATE_NO_STORE },
    });
}

export async function GET(request: Request): Promise<NextResponse> {
    return withRequestContext(async () => {
        try {
            const siteId = new URL(request.url).searchParams.get('siteId');
            if (!siteId) return json({ error: 'Missing siteId' }, 400);
            if (!(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);

            const site = await new SiteRepo().getSite(siteId);
            if (!site) return json({ error: 'Site not found' }, 404);

            const asOf = new Date();
            const historyEndDate = Temporal.Instant.from(asOf.toISOString())
                .toZonedDateTimeISO(site.timezone)
                .toPlainDate();
            const historyStartDate = historyEndDate.subtract({ days: HISTORY_DAYS });
            const historyEnd = new Date(historyEndDate.toZonedDateTime({ timeZone: site.timezone }).epochMilliseconds);
            const historyStart = new Date(historyStartDate.toZonedDateTime({ timeZone: site.timezone }).epochMilliseconds);

            const rows = await new EnergyRepo().getRawEnergyData(siteId, historyStart, historyEnd);
            const context = buildLoadPlanningContext(rows, site.timezone, asOf);
            return json({
                version: 1,
                site: { id: site.id, timezone: site.timezone },
                units: { power: 'kW', localMinute: 'minute-of-day' },
                asOf: asOf.toISOString(),
                ...context,
            });
        } catch (error) {
            console.error('[mobile-load-planning-context] request failed:', error);
            return json({ error: 'Failed to fetch mobile load planning context' }, 500);
        }
    });
}
