import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { SiteService } from '@/lib/site-service';
import { verifySiteToken } from '@/lib/auth-jwt';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');

        if (!siteId) {
            return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
        }

        const cookieStore = await cookies();
        let token = cookieStore.get('access_token')?.value;
        let refreshToken = cookieStore.get('refresh_token')?.value;

        const siteAuthToken = cookieStore.get('site_auth')?.value;
        const repo = new EnergyRepo();

        // Try to use DB tokens if authorized
        if (siteAuthToken) {
            const siteIds = verifySiteToken(siteAuthToken);
            if (siteIds && siteIds.includes(siteId)) {
                const site = await repo.getSite(siteId);
                if (site && site.access_token && site.refresh_token) {
                    token = site.access_token;
                    refreshToken = site.refresh_token;
                }
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
                // If using DB tokens, the repo handler updates DB. 
                // We can optionally update cookies if we wanted to keep them in sync, 
                // but Server Actions/Routes can't easily set cookies in a streaming response or sometimes restrict it.
                // For now, logging is sufficient as DB is SOT.
            }
        });
        const service = new SiteService({ teslaClient: client, energyRepo: repo, siteAuthToken });

        if (!await service.validateSiteAccess(siteId)) {
            return NextResponse.json({ error: 'Unauthorized access to site' }, { status: 403 });
        }

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
