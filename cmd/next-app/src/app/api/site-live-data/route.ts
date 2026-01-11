import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo, getUserTokensForSite } from '@/lib/energy-repo';
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
        let token: string | undefined;
        let refreshToken: string | undefined;

        const siteAuthToken = cookieStore.get('site_auth')?.value;
        const repo = new EnergyRepo();

        if (siteAuthToken) {
            const siteIds = verifySiteToken(siteAuthToken);
            if (siteIds && siteIds.includes(siteId)) {
                // Fetch tokens from User table via Site relationship
                const userTokens = await getUserTokensForSite(siteId);
                if (userTokens) {
                    token = userTokens.access_token;
                    refreshToken = userTokens.refresh_token;
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
            }
        });
        const service = new SiteService({ teslaClient: client, energyRepo: repo, siteAuthToken });

        // Allow if valid siteAuthToken OR if legacy token matches logic
        // Since validateSiteAccess strictly checks siteAuthToken if present (or fails if not), 
        // we need to manually bypass it if we are using legacy token and NO siteAuthToken.
        if (siteAuthToken) {
            if (!await service.validateSiteAccess(siteId)) {
                return NextResponse.json({ error: 'Unauthorized access to site' }, { status: 403 });
            }
        } else {
            // Fallback: If no siteAuthToken, we assume legacy mode where having a valid token 
            // and being able to fetch products (which client.getLiveStatus will effectively check) is enough?
            // Or better: check if the site belongs to the user associated with the token?
            // For now, let's allow it, but we rely on Tesla API to reject if token is invalid for this site.
            // But wait, the token is site-agnostic (User token).
            // If I have a token, I can access any site I own.
            // So if I have a token, and I request siteId, Tesla API will validte it.
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
