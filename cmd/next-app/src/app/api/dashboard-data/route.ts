import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SiteRepo } from '@/lib/site-repo';
import { SiteService } from '@/lib/site-service';
import { Schedule } from '@/lib/schedule';
import { withRequestContext } from '@/lib/request-context';

export const dynamic = 'force-dynamic';

export async function GET() {
    return withRequestContext(async () => {
        try {
            const cookieStore = await cookies();
            const siteAuthToken = cookieStore.get('site_auth')?.value;

            const siteRepo = new SiteRepo();
            const siteService = new SiteService({
                siteRepo,
                siteAuthToken
            });

            const batterySites = await siteService.getAuthorizedSites();
            if (batterySites.length === 0) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const productsWithTariff = await Promise.all(batterySites.map(async (basicSite) => {
                const site = await siteRepo.getSite(basicSite.id);
                
                let currentTariff = 'Unknown';
                let liveBatteryPower = 0;
                let liveSolarPower = 0;
                let liveLoadPower = 0;
                let liveGridPower = 0;
                let percentageCharged = 0;

                // Get cached or inline live status
                const liveStatus = await siteService.getLiveStatus(basicSite.id);
                if (liveStatus) {
                    liveBatteryPower = liveStatus.battery_power;
                    liveSolarPower = liveStatus.solar_power;
                    liveLoadPower = liveStatus.load_power;
                    liveGridPower = liveStatus.grid_power;
                    percentageCharged = liveStatus.percentage_charged;
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

