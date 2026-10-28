import { NextResponse } from 'next/server';
import { getCurrentRoles, verifySiteAccess } from '@/lib/auth-checks';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { withRequestContext } from '@/lib/request-context';
import { SiteRepo } from '@/lib/site-repo';
import { hasSolarForecastBeta } from '@/lib/solar-forecast-beta';
import { hourlySolarWh, solarActualsWindow } from '@/lib/solar-layout/hourly-actuals';

export const dynamic = 'force-dynamic';

const PRIVATE_NO_STORE = 'private, no-store, max-age=0';

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: { 'Cache-Control': PRIVATE_NO_STORE } });
}

/** Hourly solar Wh for the 14 local days before today plus today, for the phone's forecast correction. */
export async function GET(request: Request): Promise<NextResponse> {
    return withRequestContext(async () => {
        try {
            const siteId = new URL(request.url).searchParams.get('siteId');
            if (!siteId) return json({ error: 'Missing siteId' }, 400);
            if (!(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
            if (!hasSolarForecastBeta(await getCurrentRoles())) return json({ version: 1, enabled: false });
            const site = await new SiteRepo().getSite(siteId);
            if (!site) return json({ error: 'Site not found' }, 404);
            const asOf = new Date();
            const { start, end } = solarActualsWindow(asOf, site.timezone);
            const rows = await createEnergyRepo(site.timezone).getRawEnergyData(siteId, start, end);
            return json({ version: 1, enabled: true, asOf: asOf.toISOString(), hours: hourlySolarWh(rows) });
        } catch (error) {
            console.error('[mobile-solar-actuals] request failed:', error);
            return json({ error: 'Failed to fetch solar actuals' }, 500);
        }
    });
}
