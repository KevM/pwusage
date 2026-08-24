import { NextResponse } from 'next/server';
import { isTeslaAuthError } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { Schedule, getCurrentTariffLabel } from '@/lib/schedule';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { refreshLiveStatus } from '@/lib/today-refresh';
import { getCurrentCycleStart } from '@/lib/billing-cycle';
import { getCachedCycleRollup } from '@/lib/cycle-rollup-cache';
import { activePeriodSurplusKwh, todayNetExportByPeriod } from '@/lib/headroom-from-bins';
import { glyphForHeadroom, profileForHeadroom } from '@/lib/load-affordance';
import type { SiteLiveDataHeadroom } from '@/lib/site-live-data-client';
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

            if (!(await verifySiteAccess(siteId))) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const siteRepo = new SiteRepo();
            const repo = new EnergyRepo();

            const now = new Date();
            const scaleWindowHours = parseScaleWindowHours(process.env.SPARKLINE_SCALE_WINDOW_HOURS);
            const sparklineWindowStart = new Date(now.getTime() - (SPARKLINE_DISPLAY_WINDOW_HOURS * 60 * 60 * 1000));
            const sparklineScaleStart = new Date(now.getTime() - (scaleWindowHours * 60 * 60 * 1000));

            const [liveResult, site, historyRows] = await Promise.all([
                refreshLiveStatus(siteId, { cacheTtlMs: 60 * 1000 }),
                siteRepo.getSite(siteId),
                repo.getBucketedEnergyData(siteId, sparklineScaleStart, now)
            ]);

            if (liveResult.status === 'no-tokens' || liveResult.status === 'site-not-found') {
                return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
            }

            if (!liveResult.liveStatus) {
                return NextResponse.json({ error: liveResult.errorMessage || 'Failed to fetch live status' }, { status: 500 });
            }

            const liveStatus = liveResult.liveStatus;

            const currentTariff = getCurrentTariffLabel(site);

            // Headroom for the active TOU period. Today's contribution comes
            // from `historyRows`, already fetched above for the sparklines —
            // the rolling 24h window always covers site-local midnight — so
            // the only added query is the completed-days rollup, cached to the
            // day boundary.
            let loadHeadroom: SiteLiveDataHeadroom | null = null;
            try {
                if ((site?.tariffs?.length ?? 0) > 0) {
                    const schedule = new Schedule(site!.tariffs, site!.timezone);
                    const activeName = schedule.getTariffPeriod(now)?.schedule.name ?? null;

                    if (activeName) {
                        const siteMidnight = EnergyRepo.getSiteMidnight(now, site!.timezone);
                        const cycleStart = getCurrentCycleStart(site!.billing_start_day, now, site!.timezone);
                        const tariffVersionKey = site!.tariffs.map(t => `${t.id}:${new Date(t.updated).getTime()}`).join(',');

                        const priorCycle = await getCachedCycleRollup(
                            siteId, cycleStart, siteMidnight,
                            () => repo.getUsageByTOU(siteId, cycleStart, siteMidnight),
                            tariffVersionKey
                        );

                        const surplusKwh = activePeriodSurplusKwh(
                            priorCycle,
                            todayNetExportByPeriod(historyRows, siteMidnight, schedule),
                            activeName
                        );

                        loadHeadroom = {
                            surplusKwh,
                            periodName: activeName,
                            glyph: glyphForHeadroom(surplusKwh),
                            profileLabel: profileForHeadroom(surplusKwh)?.label ?? null,
                        };
                    }
                }
            } catch (headroomError) {
                // Never fail the live strip over the glyph.
                console.warn('[site-live-data] headroom unavailable:', headroomError);
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
                loadHeadroom,
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

