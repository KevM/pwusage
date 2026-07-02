import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { isTeslaAuthError } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { SiteService } from '@/lib/site-service';
import { Schedule } from '@/lib/schedule';
import { withRequestContext } from '@/lib/request-context';
import {
    parseScaleWindowHours,
    SPARKLINE_DISPLAY_WINDOW_HOURS,
    toSparklinePayload,
} from './sparkline-utils';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    return withRequestContext(async () => {
        try {
            const { searchParams } = new URL(request.url);
            const siteId = searchParams.get('siteId');

            if (!siteId) {
                return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
            }

            const cookieStore = await cookies();
            const siteAuthToken = cookieStore.get('site_auth')?.value;

            const siteRepo = new SiteRepo();
            const repo = new EnergyRepo();
            const siteService = new SiteService({
                siteRepo,
                siteAuthToken
            });

            if (!await siteService.validateSiteAccess(siteId)) {
                return NextResponse.json({ error: 'Unauthorized site access' }, { status: 403 });
            }

            const now = new Date();
            const scaleWindowHours = parseScaleWindowHours(process.env.SPARKLINE_SCALE_WINDOW_HOURS);
            const sparklineWindowStart = new Date(now.getTime() - (SPARKLINE_DISPLAY_WINDOW_HOURS * 60 * 60 * 1000));
            const sparklineScaleStart = new Date(now.getTime() - (scaleWindowHours * 60 * 60 * 1000));

            const [liveStatus, site, historyRows] = await Promise.all([
                siteService.getLiveStatus(siteId),
                siteRepo.getSite(siteId),
                repo.getBucketedEnergyData(siteId, sparklineScaleStart, now)
            ]);

            if (!liveStatus) {
                return NextResponse.json({ error: 'Failed to fetch live status' }, { status: 502 });
            }

            let currentTariff = 'Unknown';

            if (site && site.tariffs.length > 0) {
                const schedule = new Schedule(site.tariffs, site.timezone);
                const tariffPeriod = schedule.getTariffPeriod(new Date());
                if (tariffPeriod) {
                    const season = tariffPeriod.season.name || 'Season';
                    const tariffName = tariffPeriod.tariff.name || 'Unknown';
                    currentTariff = `${season} - ${tariffName}`;
                }
            }

            const { series: sparklines, scales: sparklineScales } = toSparklinePayload(historyRows, now, {
                solar: liveStatus.solar_power,
                grid: liveStatus.grid_power,
                load: liveStatus.load_power
            }, sparklineWindowStart);

            return NextResponse.json({
                solarPower: liveStatus.solar_power,
                loadPower: liveStatus.load_power,
                batteryPower: liveStatus.battery_power,
                gridPower: liveStatus.grid_power,
                percentageCharged: liveStatus.percentage_charged,
                currentTariff,
                sparklines,
                sparklineScales
            });
        } catch (error) {
            console.error('Site live data error:', error);
            if (isTeslaAuthError(error)) {
                return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
            }

            return NextResponse.json({ error: 'Failed to fetch site live data' }, { status: 500 });
        }
    });
}

