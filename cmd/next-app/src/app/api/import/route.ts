import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { createTeslaClientForSite } from '@/lib/tesla-client-factory';
import { getAuthorizedSiteIds } from '@/lib/auth-checks';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const granularity = searchParams.get('granularity') || 'day';

        const authorizedSites = await getAuthorizedSiteIds();
        if (authorizedSites.length === 0) {
            return NextResponse.json({ error: 'No sites authorized' }, { status: 403 });
        }

        // Default behavior (Auto-import recent history)
        const now = new Date();
        const autoBackfillLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        // Instantiate client once using the credentials for the primary authorized site
        const client = await createTeslaClientForSite(authorizedSites[0], {
            onTokenUpdate: () => console.log('Tokens refreshed during import')
        });

        if (!client) {
            return NextResponse.json({ error: 'Unauthorized or no credentials found' }, { status: 401 });
        }

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

        const allFailed = authorizedSites.length > 0 && successCount === 0;

        return NextResponse.json({
            success: !allFailed,
            sitesImported: authorizedSites.length,
            successCount,
            errors: Object.keys(errors).length > 0 ? errors : undefined,
            granularity
        }, {
            status: allFailed ? 502 : 200
        });
    } catch (error) {
        console.error('Import error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
