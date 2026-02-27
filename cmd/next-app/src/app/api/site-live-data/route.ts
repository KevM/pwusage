import { NextResponse } from 'next/server';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo, getUserTokensForSite } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { verifySiteAccess } from '@/lib/auth-checks';
import {
    parseScaleWindowHours,
    SPARKLINE_DISPLAY_WINDOW_HOURS,
    toSparklinePayload,
} from './sparkline-utils';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');

        if (!siteId) {
            return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
        }

        let token: string | undefined;
        let refreshToken: string | undefined;

        const repo = new EnergyRepo();

        if (await verifySiteAccess(siteId)) {
            // Fetch tokens from User table via Site relationship
            const userTokens = await getUserTokensForSite(siteId);
            if (userTokens) {
                token = userTokens.access_token;
                refreshToken = userTokens.refresh_token;
            }
        }

        if (!token) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const handlers = repo.getLockedRefreshHandler(siteId);
        const client = new TeslaClient({
            accessToken: token,
            refreshToken: refreshToken,
            tokenRefreshHandler: handlers.refreshHandler,
            onTokenError: handlers.errorHandler,
            onTokenUpdate: () => {
            }
        });


        const now = new Date();
        const scaleWindowHours = parseScaleWindowHours(process.env.SPARKLINE_SCALE_WINDOW_HOURS);
        const sparklineWindowStart = new Date(now.getTime() - (SPARKLINE_DISPLAY_WINDOW_HOURS * 60 * 60 * 1000));
        const sparklineScaleStart = new Date(now.getTime() - (scaleWindowHours * 60 * 60 * 1000));

        const [liveStatus, site, historyRows] = await Promise.all([
            client.getLiveStatus(siteId),
            repo.getSite(siteId),
            repo.getRawEnergyData(siteId, sparklineScaleStart, now)
        ]);

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
        const msg = error instanceof Error ? error.message : String(error);

        if (msg.includes('401') || msg.includes('login_required') || msg.includes('Tesla API Error: 401')) {
            return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
        }

        return NextResponse.json({ error: 'Failed to fetch site live data' }, { status: 500 });
    }
}
