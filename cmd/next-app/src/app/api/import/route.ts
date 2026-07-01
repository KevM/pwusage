import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { TeslaTokenRepo } from '@/lib/tesla-token-repo';
import { SiteRepo } from '@/lib/site-repo';
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

        const tokenRepo = new TeslaTokenRepo(new SiteRepo());

        // Default behavior (Auto-import recent history)
        const now = new Date();
        const autoBackfillLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        // Instantiate client once using the credentials
        // We use the first site ID for the refresh handler context (locks the User)
        const handlers = tokenRepo.getLockedRefreshHandler(authorizedSites[0]);
        const client = new TeslaClient({
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token || undefined,
            tokenRefreshHandler: handlers.refreshHandler,
            onTokenError: handlers.errorHandler,
            onTokenUpdate: () => console.log(`Tokens refreshed during import`)
        });

        const importer = new Importer(client);
        const errors: Record<string, string> = {};
        let successCount = 0;

        for (const siteId of authorizedSites) {
            try {
                console.log(`Auto-importing site ${siteId} (last 14 days)`);
                await importer.ensureDataForRange(siteId, autoBackfillLimit, now);
                successCount++;
            } catch (err) {
                console.error(`Auto-import failed for site ${siteId}:`, err);
                errors[siteId] = err instanceof Error ? err.message : String(err);
            }
        }

        return NextResponse.json({
            success: successCount > 0 || authorizedSites.length === 0,
            sitesImported: authorizedSites.length,
            successCount,
            errors: Object.keys(errors).length > 0 ? errors : undefined,
            granularity
        });
    } catch (error) {
        console.error('Import error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
