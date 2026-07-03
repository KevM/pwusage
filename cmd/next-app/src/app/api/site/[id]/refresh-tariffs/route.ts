import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { createTeslaClientForSite } from '@/lib/tesla-client-factory';
import { Importer } from '@/lib/importer';
import { SiteRepo } from '@/lib/site-repo';
import { withRequestContext } from '@/lib/request-context';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return withRequestContext(async () => {
        try {
        const { id: siteId } = await params;

        // Verify user has access to this site
        const hasAccess = await verifySiteAccess(siteId);
        if (!hasAccess) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        // Verify site exists
        const siteRepo = new SiteRepo();
        const site = await siteRepo.getSite(siteId);
        if (!site) {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        // Create Tesla client and importer
        const client = await createTeslaClientForSite(siteId);
        if (!client) {
            return NextResponse.json({ error: 'Site has no Tesla credentials' }, { status: 401 });
        }

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
    });
}
