import { NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { cookies } from 'next/headers';
import { EnergySiteInfo } from '@/lib/tesla-client';
import { SiteService } from '@/lib/site-service';
import { Site } from '@/lib/db';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const uuid = searchParams.get('uuid');
        const token = searchParams.get('token');

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        // AUTH STRATEGY:
        // 1. Site Auth (User) - Returns all authorized sites
        // 2. Trmnl Token (Device) - Returns ONLY the linked site (if any)

        const repo = new EnergyRepo();
        let sites: Site[] = [];

        if (token && uuid) {
            // Check Trmnl Auth
            try {
                // Let's use `site_auth` if available FIRST.
                if (siteAuthToken) {
                    const service = new SiteService({ energyRepo: repo, siteAuthToken });
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
                energyRepo: repo,
                siteAuthToken
            });
            sites = await service.getAuthorizedSites();
        }

        // Map to simple structure
        const result = sites.map(s => {
            const info = s.json as unknown as EnergySiteInfo;
            const utility = info?.tariff_content_v2?.utility ?? 'Unknown Utility';
            return {
                id: s.id,
                name: s.name,
                utility
            };
        });

        return NextResponse.json(result);
    } catch (error) {
        console.error('Failed to fetch sites:', error);
        return NextResponse.json({ error: `Failed to fetch sites: ${(error as Error).message}` }, { status: 500 });
    }
}
