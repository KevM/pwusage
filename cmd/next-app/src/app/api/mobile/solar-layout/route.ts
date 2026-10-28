import { NextResponse } from 'next/server';
import { getCurrentRoles, verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { hasSolarForecastBeta } from '@/lib/solar-forecast-beta';
import { roundCoordinate, SolarLayoutRepo } from '@/lib/solar-layout-repo';
import { toMobileSolarLayout } from '@/lib/solar-layout/mobile-contract';

export const dynamic = 'force-dynamic';

const PRIVATE_NO_STORE = 'private, no-store, max-age=0';

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: { 'Cache-Control': PRIVATE_NO_STORE } });
}

/** The site's detected solar layout for the phone's Forecast.Solar requests. */
export async function GET(request: Request): Promise<NextResponse> {
    return withRequestContext(async () => {
        try {
            const siteId = new URL(request.url).searchParams.get('siteId');
            if (!siteId) return json({ error: 'Missing siteId' }, 400);
            if (!(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);
            if (!hasSolarForecastBeta(await getCurrentRoles())) return json({ version: 1, enabled: false });
            return json(toMobileSolarLayout(await new SolarLayoutRepo().get(siteId)));
        } catch (error) {
            console.error('[mobile-solar-layout] request failed:', error);
            return json({ error: 'Failed to fetch solar layout' }, 500);
        }
    });
}

function validCoordinate(value: unknown, limit: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** Stores the home location (rounded to ~1 km) the phone read for the site. */
export async function POST(request: Request): Promise<NextResponse> {
    return withRequestContext(async () => {
        try {
            let body: { siteId?: unknown; latitude?: unknown; longitude?: unknown };
            try {
                body = await request.json();
            } catch {
                return json({ error: 'Invalid JSON' }, 400);
            }
            if (!body || typeof body.siteId !== 'string' || !body.siteId) return json({ error: 'Missing siteId' }, 400);
            if (!(await verifySiteAccess(body.siteId))) return json({ error: 'Unauthorized' }, 401);
            if (!hasSolarForecastBeta(await getCurrentRoles())) return json({ error: 'Forbidden' }, 403);
            if (!validCoordinate(body.latitude, 90) || !validCoordinate(body.longitude, 180)) {
                return json({ error: 'Invalid location' }, 400);
            }
            await new SolarLayoutRepo().setLocation(body.siteId, roundCoordinate(body.latitude), roundCoordinate(body.longitude));
            return new NextResponse(null, { status: 204, headers: { 'Cache-Control': PRIVATE_NO_STORE } });
        } catch (error) {
            console.error('[mobile-solar-layout] location update failed:', error);
            return json({ error: 'Failed to store location' }, 500);
        }
    });
}
