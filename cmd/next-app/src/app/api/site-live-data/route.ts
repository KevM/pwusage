import { NextResponse } from 'next/server';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo, getUserTokensForSite } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { verifySiteAccess } from '@/lib/auth-checks';
import type { EnergyData } from '@/lib/db';
import { energyToAveragePower } from '@/lib/energy-utils';

export const dynamic = 'force-dynamic';

type SparklineMetricKey = 'solar' | 'grid' | 'load';

interface SparklinePoint {
    timestamp: string;
    watts: number;
}

interface SparklineSeries {
    solar: SparklinePoint[];
    grid: SparklinePoint[];
    load: SparklinePoint[];
}

function toSparklineSeries(historyRows: EnergyData[], liveTimestamp: Date, liveValues: {
    solar: number;
    grid: number;
    load: number;
}): SparklineSeries {
    const history: Record<SparklineMetricKey, SparklinePoint[]> = {
        // EnergyData stores interval energy (Wh); convert to average watts to match live Tesla readings.
        solar: historyRows.map((row) => ({ timestamp: row.timestamp.toISOString(), watts: energyToAveragePower(row.solar_power) })),
        grid: historyRows.map((row) => ({ timestamp: row.timestamp.toISOString(), watts: energyToAveragePower(row.grid_power) })),
        load: historyRows.map((row) => ({ timestamp: row.timestamp.toISOString(), watts: energyToAveragePower(row.load_power) })),
    };

    const liveIso = liveTimestamp.toISOString();

    const withLivePoint = (metric: SparklineMetricKey): SparklinePoint[] => {
        const points = history[metric];
        const livePoint: SparklinePoint = { timestamp: liveIso, watts: liveValues[metric] };
        const lastPoint = points.at(-1);

        if (lastPoint?.timestamp === liveIso) {
            return [...points.slice(0, -1), livePoint];
        }

        return [...points, livePoint];
    };

    return {
        solar: withLivePoint('solar'),
        grid: withLivePoint('grid'),
        load: withLivePoint('load'),
    };
}

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
        const historyStart = new Date(now.getTime() - (4 * 60 * 60 * 1000));

        const [liveStatus, site, historyRows] = await Promise.all([
            client.getLiveStatus(siteId),
            repo.getSite(siteId),
            repo.getRawEnergyData(siteId, historyStart, now)
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

        const sparklines = toSparklineSeries(historyRows, now, {
            solar: liveStatus.solar_power,
            grid: liveStatus.grid_power,
            load: liveStatus.load_power
        });

        return NextResponse.json({
            solarPower: liveStatus.solar_power,
            loadPower: liveStatus.load_power,
            batteryPower: liveStatus.battery_power,
            gridPower: liveStatus.grid_power,
            percentageCharged: liveStatus.percentage_charged,
            currentTariff,
            sparklines
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
