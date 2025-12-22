import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { EnergyRepo } from '@/lib/energy-repo';
import { TeslaClient } from '@/lib/tesla-client';
import { verifySiteToken } from '@/lib/auth-jwt';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const granularity = searchParams.get('granularity') || 'day';

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        if (!siteAuthToken) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const authorizedSites = verifySiteToken(siteAuthToken);
        if (!authorizedSites || authorizedSites.length === 0) {
            return NextResponse.json({ error: 'No sites authorized' }, { status: 403 });
        }

        const repo = new EnergyRepo();

        // Default behavior (Auto-import recent history)
        const now = new Date();
        const autoBackfillLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        for (const siteId of authorizedSites) {
            const site = await repo.getSite(siteId);
            if (!site || !site.access_token) {
                console.warn(`Skipping import for site ${siteId} - No tokens found`);
                continue;
            }

            const client = new TeslaClient({
                accessToken: site.access_token,
                refreshToken: site.refresh_token || undefined,
                tokenRefreshHandler: repo.getLockedRefreshHandler(siteId),
                onTokenUpdate: () => console.log(`Tokens refreshed for site ${siteId} during import`)
            });

            const importer = new Importer(client);

            console.log(`Auto-importing site ${siteId} (last 14 days)`);
            await importer.ensureDataForRange(siteId, autoBackfillLimit, now);
        }

        return NextResponse.json({ success: true, sitesImported: authorizedSites.length, granularity });
    } catch (error) {
        console.error('Import error full stack:', error);
        return NextResponse.json({ error: (error as Error).message, stack: (error as Error).stack }, { status: 500 });
    }
}
