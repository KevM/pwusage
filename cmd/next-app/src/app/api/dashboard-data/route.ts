import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { TeslaClient, EnergySiteInfo } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { Importer } from '@/lib/importer';
import { SiteService } from '@/lib/site-service';
import { verifySiteToken } from '@/lib/auth-jwt';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const cookieStore = await cookies();
        let token = cookieStore.get('access_token')?.value;
        let refreshToken = cookieStore.get('refresh_token')?.value;
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        let activeSiteId: string | null = null;
        if (siteAuthToken) {
            const siteIds = verifySiteToken(siteAuthToken);
            if (siteIds && siteIds.length > 0) {
                const repo = new EnergyRepo();
                const primarySite = await repo.getSite(siteIds[0]);
                if (primarySite && primarySite.access_token && primarySite.refresh_token) {
                    token = primarySite.access_token;
                    refreshToken = primarySite.refresh_token;
                    activeSiteId = primarySite.id;
                }
            }
        }

        if (!token) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Determine refresh handler
        let refreshHandler;
        if (activeSiteId) {
            const repo = new EnergyRepo();
            refreshHandler = repo.getLockedRefreshHandler(activeSiteId);
        }

        const client = new TeslaClient({
            accessToken: token,
            refreshToken: refreshToken,
            tokenRefreshHandler: refreshHandler,
            onTokenUpdate: () => {
                // Token handling logic handled by repo handler
            }
        });

        const repo = new EnergyRepo();
        const importer = new Importer(client);
        const service = new SiteService({
            teslaClient: client,
            energyRepo: repo,
            siteAuthToken
        });

        // Use cached authorization source of truth
        const sites = await service.getAuthorizedSites();

        // Filter for battery sites (using DB info if available, or assume yes for now as we only sync battery sites usually?)
        // Let's check site.json for components.battery
        const batterySites = sites.filter(s => {
            const info = s.json as unknown as EnergySiteInfo;
            // EnergySiteInfo has components.battery as boolean
            return info?.components?.battery === true;
        });

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
}
