import { NextResponse } from 'next/server';

import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { Importer } from '@/lib/importer';
import { getTeslaCredentials, getAuthorizedSiteIds } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';

export const dynamic = 'force-dynamic';

export async function GET() {
    return withRequestContext(async () => {
        try {
        const authorizedSiteIds = await getAuthorizedSiteIds();
        if (authorizedSiteIds.length === 0) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const credentials = await getTeslaCredentials();
        if (!credentials) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const activeSiteId = authorizedSiteIds[0];
        const repo = new EnergyRepo();
        const handlers = repo.getLockedRefreshHandler(activeSiteId);

        const client = new TeslaClient({
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token || undefined,
            tokenRefreshHandler: handlers.refreshHandler,
            onTokenError: handlers.errorHandler,
            onTokenUpdate: () => {
                // Token handling logic handled by repo handler
            }
        });

        const importer = new Importer(client);

        // Use cached authorization source of truth
        // Fetch sites directly from repo using the authorized IDs we already validated
        const sitesPromises = authorizedSiteIds.map(id => repo.getSite(id));
        const sitesResults = await Promise.all(sitesPromises);
        const batterySites = sitesResults.filter((s): s is NonNullable<typeof s> => !!s);

        const productsWithTariff = await Promise.all(batterySites.map(async (basicSite) => {
            // Fetch full site details including tariffs (which are not in the basic Site object)
            let site = await repo.getSite(basicSite.id);

            if (!site) {
                // Should be rare as basicSite came from DB, but possible due to race conditions or partial writes?
                // Or if getAuthorizedSites used stale cache? 
                // We can try to repair it.
                console.warn(`[Dashboard] Site ${basicSite.id} found in list but getSite returned null. Attempting repair.`);
                site = await importer.ensureSite(basicSite.id);
            }

            let currentTariff = 'Unknown';
            let liveBatteryPower = 0;
            let liveSolarPower = 0;
            let liveLoadPower = 0;
            let liveGridPower = 0;
            let percentageCharged = 0;

            // Get live status for real-time data
            try {
                const liveStatus = await client.getLiveStatus(basicSite.id);
                liveBatteryPower = liveStatus.battery_power;
                liveSolarPower = liveStatus.solar_power;
                liveLoadPower = liveStatus.load_power;
                liveGridPower = liveStatus.grid_power;
                percentageCharged = liveStatus.percentage_charged;
            } catch (error) {
                console.warn(`Failed to fetch live status for site ${basicSite.id}:`, error);
            }

            if (site && site.tariffs.length > 0) {
                const schedule = new Schedule(site.tariffs, site.timezone);
                const tariffPeriod = schedule.getTariffPeriod(new Date());
                if (tariffPeriod) {
                    const season = tariffPeriod.season.name || 'Season';
                    const tariffName = tariffPeriod.tariff.name || 'Unknown';
                    currentTariff = `${season} - ${tariffName}`;
                }
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
