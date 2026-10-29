import { NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { buildMobileLivePowerContract } from '@/lib/mobile-dashboard-contract';
import { withRequestContext } from '@/lib/request-context';
import { refreshLiveStatus } from '@/lib/today-refresh';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Live power and charge only. Never reads energy history or cycle rollups. */
export async function GET(request: Request) {
    return withRequestContext(async () => {
        const siteID = new URL(request.url).searchParams.get('siteId');
        if (!siteID) return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
        if (!(await verifySiteAccess(siteID))) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        // A visible app explicitly needs a current Tesla reading. Preserve the
        // shared refresh implementation and its in-flight coalescing; force is
        // the existing supported path around the background cache/claim cadence.
        const result = await refreshLiveStatus(siteID, { force: true, liveOnly: true });
        if (result.status === 'connection-required' || result.status === 'no-tokens') {
            return NextResponse.json({ error: 'Reconnect Tesla to update your data.', code: 'TESLA_CONNECTION_REQUIRED' }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } });
        }
        if (result.status === 'site-not-found') {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }
        if (!result.liveStatus) {
            return NextResponse.json({ error: 'Live readings unavailable' }, { status: 503 });
        }
        return NextResponse.json(buildMobileLivePowerContract({
            siteID, live: result.liveStatus, now: new Date(),
        }), { headers: { 'Cache-Control': 'private, no-store' } });
    });
}
