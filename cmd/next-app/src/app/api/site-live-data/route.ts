import { NextResponse } from 'next/server';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo, getUserTokensForSite } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { verifySiteAccess } from '@/lib/auth-checks';

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

        const client = new TeslaClient({
            accessToken: token,
            refreshToken: refreshToken,
            tokenRefreshHandler: repo.getLockedRefreshHandler(siteId),
            onTokenUpdate: () => {
            }
        });


        // Get live status
        const liveStatus = await client.getLiveStatus(siteId);

        // Get current tariff
        const site = await repo.getSite(siteId);
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

        return NextResponse.json({
            solarPower: liveStatus.solar_power,
            loadPower: liveStatus.load_power,
            batteryPower: liveStatus.battery_power,
            gridPower: liveStatus.grid_power,
            percentageCharged: liveStatus.percentage_charged,
            currentTariff
        });
    } catch (error) {
        console.error('Site live data error:', error);
        return NextResponse.json({ error: 'Failed to fetch site live data' }, { status: 500 });
    }
}
