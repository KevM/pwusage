import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { TeslaClient } from '@/lib/tesla-client';
import { Importer } from '@/lib/importer';
import { EnergyRepo, getUserTokensForSite } from '@/lib/energy-repo';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: siteId } = await params;

        // Verify user has access to this site
        const hasAccess = await verifySiteAccess(siteId);
        if (!hasAccess) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        // Get site-specific Tesla credentials (from the site owner)
        const credentials = await getUserTokensForSite(siteId);
        if (!credentials) {
            return NextResponse.json({ error: 'Site has no Tesla credentials' }, { status: 401 });
        }

        // Verify site exists
        const repo = new EnergyRepo();
        const site = await repo.getSite(siteId);
        if (!site) {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        // Create Tesla client and importer
        const handlers = repo.getLockedRefreshHandler(siteId);
        const client = new TeslaClient({
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token || undefined,
            tokenRefreshHandler: handlers.refreshHandler,
            onTokenError: handlers.errorHandler,
        });

        const importer = new Importer(client);

        // Refresh tariffs
        const updatedSite = await importer.ensureSite(siteId);

        if (!updatedSite) {
            return NextResponse.json(
                { error: 'Failed to refresh tariffs' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            message: 'Tariffs refreshed successfully',
            tariffCount: updatedSite.tariffs.length
        });
    } catch (error) {
        console.error(`[API] Refresh tariffs error:`, error);
        const message = error instanceof Error ? error.message : 'Failed to refresh tariffs';
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}
