import { NextResponse } from 'next/server';

import { SiteRepo } from '@/lib/site-repo';
import { getCurrentTariffLabel } from '@/lib/schedule';
import { getAuthorizedSiteIds } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { refreshLiveStatus } from '@/lib/today-refresh';

export const dynamic = 'force-dynamic';

export async function GET() {
    return withRequestContext(async () => {
        try {
            const authorizedSiteIds = await getAuthorizedSiteIds();
            if (authorizedSiteIds.length === 0) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const siteRepo = new SiteRepo();

            // Fetch sites directly from repo using the authorized IDs we already validated
            const sitesPromises = authorizedSiteIds.map(id => siteRepo.getSite(id));
            const sitesResults = await Promise.all(sitesPromises);
            const batterySites = sitesResults.filter((s): s is NonNullable<typeof s> => !!s);

            const productsWithTariff = await Promise.all(batterySites.map(async (basicSite) => {
                const site = await siteRepo.getSite(basicSite.id);

                const currentTariff = getCurrentTariffLabel(site);
                let liveBatteryPower = 0;
                let liveSolarPower = 0;
                let liveLoadPower = 0;
                let liveGridPower = 0;
                let percentageCharged = 0;

                // Get cached or fresh live status
                try {
                    const result = await refreshLiveStatus(basicSite.id);
                    if (result.liveStatus) {
                        liveBatteryPower = result.liveStatus.battery_power;
                        liveSolarPower = result.liveStatus.solar_power;
                        liveLoadPower = result.liveStatus.load_power;
                        liveGridPower = result.liveStatus.grid_power;
                        percentageCharged = result.liveStatus.percentage_charged;
                    }
                } catch (error) {
                    console.warn(`Failed to fetch live status for site ${basicSite.id}:`, error);
                }

                return {
                    id: basicSite.id, // Using site ID as product ID for frontend consistency
                    site_name: basicSite.name,
                    energy_site_id: parseInt(basicSite.id),
                    percentage_charged: percentageCharged,
                    currentTariff,
                    liveBatteryPower,
                    liveSolarPower,
                    liveLoadPower,
                    liveGridPower
                };
            }));

            return NextResponse.json({ products: productsWithTariff });
        } catch (error) {
            console.error('Dashboard data error:', error);
            return NextResponse.json({ error: 'Failed to fetch dashboard data' }, { status: 500 });
        }
    });
}

