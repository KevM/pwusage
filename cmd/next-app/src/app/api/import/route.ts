import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { EnergyRepo } from '@/lib/energy-repo';
import { TeslaClient } from '@/lib/tesla-client';
import { getTeslaCredentials, getAuthorizedSiteIds } from '@/lib/auth-checks';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const granularity = searchParams.get('granularity') || 'day';

        const authorizedSites = await getAuthorizedSiteIds();
        if (authorizedSites.length === 0) {
            return NextResponse.json({ error: 'No sites authorized' }, { status: 403 });
        }

        const credentials = await getTeslaCredentials();
        if (!credentials) {
            return NextResponse.json({ error: 'Unauthorized or no credentials found' }, { status: 401 });
        }

        const repo = new EnergyRepo();

        // Default behavior (Auto-import recent history)
        const now = new Date();
        const autoBackfillLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        // Instantiate client once using the credentials
        // We use the first site ID for the refresh handler context (locks the User)
        const handlers = repo.getLockedRefreshHandler(authorizedSites[0]);
        const client = new TeslaClient({
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token || undefined,
            tokenRefreshHandler: handlers.refreshHandler,
            onTokenError: handlers.errorHandler,
            onTokenUpdate: () => console.log(`Tokens refreshed during import`)
        });

        const importer = new Importer(client);

        for (const siteId of authorizedSites) {
            console.log(`Auto-importing site ${siteId} (last 14 days)`);
            await importer.ensureDataForRange(siteId, autoBackfillLimit, now);
        }

        return NextResponse.json({ success: true, sitesImported: authorizedSites.length, granularity });
    } catch (error) {
        console.error('Import error full stack:', error);
        return NextResponse.json({ error: (error as Error).message, stack: (error as Error).stack }, { status: 500 });
    }
}
