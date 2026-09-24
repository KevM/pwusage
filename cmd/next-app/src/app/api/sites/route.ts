import { NextResponse } from 'next/server';
import { SiteRepo } from '@/lib/site-repo';
import { cookies } from 'next/headers';
import { SiteService } from '@/lib/site-service';
import { Site } from '@/lib/db';
import { withRequestContext } from '@/lib/request-context';

export async function GET(request: Request) {
    return withRequestContext(async () => {
        try {
        const { searchParams } = new URL(request.url);
        const uuid = searchParams.get('uuid');
        const token = searchParams.get('token');

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        // AUTH STRATEGY:
        // 1. Site Auth (User) - Returns all authorized sites
        // 2. Trmnl Token (Device) - Returns ONLY the linked site (if any)

        const repo = new SiteRepo();
        let sites: Site[] = [];

        if (token && uuid) {
            // Check Trmnl Auth
            try {
                // Let's use `site_auth` if available FIRST.
                if (siteAuthToken) {
                    const service = new SiteService({ siteRepo: repo, siteAuthToken });
                    sites = await service.getAuthorizedSites();
                } else {
                    // Trmnl Auth Fallback
                    const { verifyTrmnlToken } = await import('@/lib/trmnl-auth');
                    await verifyTrmnlToken(token, uuid);

                    // If verified, find the site linked to this UUID
                    const { TrmnlService } = await import('@/lib/trmnl-service');
                    const trmnlService = new TrmnlService();
                    const installation = await trmnlService.getInstallationByUuid(uuid);

                    if (installation && installation.site_id) {
                        const site = await repo.getSite(installation.site_id);
                        if (site) {
                            sites = [site];
                        }
                    }
                }
            } catch {
                // Ignore, proceed to 401
            }
        }

        if (sites.length === 0) {
            if (!siteAuthToken) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const service = new SiteService({
                siteRepo: repo,
                siteAuthToken
            });
            sites = await service.getAuthorizedSites();
        }

        // Map to simple structure
        const result = sites.map(s => ({
            id: s.id,
            name: s.name,
            utility: s.utility ?? 'Unknown Utility'
        }));

        return NextResponse.json(result);
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Unauthorized:')) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            console.error('Failed to fetch sites:', error);
            return NextResponse.json({ error: `Failed to fetch sites: ${(error as Error).message}` }, { status: 500 });
        }
    });
}
