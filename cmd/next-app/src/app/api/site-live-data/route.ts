import { NextResponse } from 'next/server';
import { isTeslaAuthError } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { Schedule, getCurrentTariffLabel } from '@/lib/schedule';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { formatSiteDate } from '@/lib/date-utils';
import { refreshLiveStatus, refreshTodayData } from '@/lib/today-refresh';
import { getCurrentCycleStart } from '@/lib/billing-cycle';
import { getCachedCycleRollup } from '@/lib/cycle-rollup-cache';
import { activePeriodSurplusKwh, missingTodayInterval, todayNetExportByPeriod } from '@/lib/headroom-from-bins';
import { activeLoadTimingForMobile } from '@/lib/mobile-load-timing';
import { glyphForHeadroom, profileForHeadroom } from '@/lib/load-affordance';
import { buildMobileDashboardContract, maxBucketSampleTimestamp, MOBILE_SOC_MAX_AGE_MS, MOBILE_SOC_STALE_AFTER_MS, sumBucketedTodayRows } from '@/lib/mobile-dashboard-contract';
import type { SiteLiveDataHeadroom } from '@/lib/site-live-data-client';
import {
    parseScaleWindowHours,
    SPARKLINE_DISPLAY_WINDOW_HOURS,
    toSparklinePayload,
} from './sparkline-utils';

export const dynamic = 'force-dynamic';
const MOBILE_ENERGY_STALE_AFTER_MS = 30 * 60 * 1000;

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

            const [liveResult, site, initialHistoryRows] = await Promise.all([
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
            const mobileView = searchParams.get('view') === 'mobile';
            let historyRows = initialHistoryRows;

            // The website refreshes today's Tesla history before reading its
            // totals. Do the same for mobile only when the stored sample is old.
            // The site import lock caps attempts across instances; a successful
            // import alone warrants a second bucket read.
            const latestEnergySample = maxBucketSampleTimestamp(historyRows);
            if (mobileView && (!latestEnergySample
                || now.getTime() - latestEnergySample.getTime() > MOBILE_ENERGY_STALE_AFTER_MS)) {
                try {
                    const refreshed = await refreshTodayData(siteId, { minIntervalMs: MOBILE_ENERGY_STALE_AFTER_MS });
                    if (refreshed.status === 'persisted') {
                        historyRows = await repo.getBucketedEnergyData(siteId, sparklineScaleStart, now);
                    } else if (refreshed.status === 'error') {
                        console.warn('[site-live-data] mobile today refresh failed:', refreshed.errorMessage);
                    }
                } catch (refreshError) {
                    console.warn('[site-live-data] mobile today refresh unavailable:', refreshError);
                }
            }

            const currentTariff = getCurrentTariffLabel(site);
            const siteTimezone = site?.timezone ?? 'UTC';
            const siteMidnight = EnergyRepo.getSiteMidnight(now, siteTimezone);
            let todayRows = historyRows;
            let todayComplete = true;
            let todayGapFetched = false;

            // Headroom for the active TOU period. Today's contribution comes
            // from `historyRows`, already fetched above for the sparklines —
            // the rolling 24h window covers site-local midnight on every
            // ordinary day — so the only added query is the completed-days
            // rollup, cached to the day boundary. The one exception is a DST
            // fallback evening; see `missingTodayInterval` below.
            let loadHeadroom: SiteLiveDataHeadroom | null = null;
            let activeLoadTiming: ReturnType<typeof activeLoadTimingForMobile> = null;
            try {
                if ((site?.tariffs?.length ?? 0) > 0) {
                    const schedule = new Schedule(site!.tariffs, site!.timezone);
                    const activeName = schedule.getTariffPeriod(now)?.schedule.name ?? null;

                    if (activeName) {
                        const siteMidnight = EnergyRepo.getSiteMidnight(now, site!.timezone);
                        const cycleStart = getCurrentCycleStart(site!.billing_start_day, now, site!.timezone);
                        const tariffVersionKey = site!.tariffs.map(t => `${t.id}:${new Date(t.updated).getTime()}`).join(',');

                        // On a DST fallback evening the local day is longer than
                        // the rolling sparkline window, so the head of today sits
                        // outside `historyRows`. Fetch only that sliver, only then.
                        const gap = missingTodayInterval(siteMidnight, sparklineScaleStart);

                        const [priorCycle, gapRows] = await Promise.all([
                            getCachedCycleRollup(
                                siteId, cycleStart, siteMidnight,
                                () => repo.getUsageByTOU(siteId, cycleStart, siteMidnight),
                                tariffVersionKey
                            ),
                            gap
                                ? repo.getBucketedEnergyData(siteId, gap.start, gap.end)
                                : Promise.resolve([])
                        ]);

                        if (gap) todayGapFetched = true;
                        if (gapRows.length > 0) todayRows = [...gapRows, ...historyRows];

                        const todayByPeriod = todayNetExportByPeriod(
                            gapRows.length > 0 ? [...gapRows, ...historyRows] : historyRows,
                            siteMidnight,
                            schedule
                        );

                        const surplusKwh = activePeriodSurplusKwh(priorCycle, todayByPeriod, activeName);

                        activeLoadTiming = activeLoadTimingForMobile(
                            schedule,
                            now,
                            priorCycle,
                            todayByPeriod,
                            maxBucketSampleTimestamp(historyRows)
                        );

                        // A site with no stored samples this cycle has an unknown
                        // surplus, not a zero one — leave the glyph off entirely.
                        if (surplusKwh !== null) {
                            loadHeadroom = {
                                surplusKwh,
                                periodName: activeName,
                                glyph: glyphForHeadroom(surplusKwh),
                                profileLabel: profileForHeadroom(surplusKwh)?.label ?? null,
                            };
                        }
                    }
                }
            } catch (headroomError) {
                // Never fail the live strip over the glyph.
                console.warn('[site-live-data] headroom unavailable:', headroomError);
            }

            // On a long local day, fetch only the small interval missing from the
            // existing rolling bucket query. This is the same exceptional gap
            // needed by headroom and never becomes a full raw-today query.
            const todayGap = missingTodayInterval(siteMidnight, sparklineScaleStart);
            if (todayGap && !todayGapFetched) {
                try {
                    const gapRows = await repo.getBucketedEnergyData(siteId, todayGap.start, todayGap.end);
                    todayRows = [...gapRows, ...historyRows];
                    todayGapFetched = true;
                    todayComplete = true;
                } catch (gapError) {
                    todayComplete = false;
                    console.warn('[site-live-data] today totals are incomplete:', gapError);
                }
            }

            const { series: sparklines, scales: sparklineScales } = toSparklinePayload(historyRows, now, {
                solar: liveStatus.solar_power,
                grid: liveStatus.grid_power,
                load: liveStatus.load_power
            }, sparklineWindowStart);

            const liveSourceMs = new Date(liveStatus.timestamp).getTime();
            const stateOfCharge = Number.isFinite(liveSourceMs)
                && now.getTime() - liveSourceMs >= 0
                && now.getTime() - liveSourceMs <= MOBILE_SOC_STALE_AFTER_MS
                ? liveStatus.percentage_charged
                : null;
            const liveSocUsable = typeof liveStatus.percentage_charged === 'number'
                && Number.isFinite(liveStatus.percentage_charged)
                && liveStatus.percentage_charged >= 0 && liveStatus.percentage_charged <= 100
                && Number.isFinite(liveSourceMs)
                && now.getTime() - liveSourceMs >= 0
                && now.getTime() - liveSourceMs <= MOBILE_SOC_MAX_AGE_MS;
            // Most responses use the already-fetched live cache. Only a missing
            // value incurs one small, indexed DB read; never fetch Tesla again.
            const fallbackSoc = mobileView && !liveSocUsable
                ? await repo.getLatestBatterySoc(siteId, new Date(now.getTime() - MOBILE_SOC_MAX_AGE_MS))
                : null;
            const mobileContract = buildMobileDashboardContract({
                site: { id: siteId, name: site?.name ?? '', timezone: siteTimezone },
                live: liveStatus,
                fallbackSoc,
                energyTimestamp: maxBucketSampleTimestamp(historyRows),
                now,
                activeTariff: currentTariff,
                activeLoadTiming,
                today: sumBucketedTodayRows(todayRows, siteMidnight),
                todayComplete,
                bill: null,
                todayDate: formatSiteDate(now, siteTimezone),
            });

            if (mobileView) {
                return NextResponse.json(mobileContract);
            }

            return NextResponse.json({
                solarPower: liveStatus.solar_power,
                loadPower: liveStatus.load_power,
                batteryPower: liveStatus.battery_power,
                gridPower: liveStatus.grid_power,
                percentageCharged: liveStatus.percentage_charged,
                stateOfCharge,
                sourceTimestamps: mobileContract.sources,
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
