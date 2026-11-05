import { createHash } from 'node:crypto';
import { logEvent, observeRoute, setLogContext } from '@/lib/observability';
import type { MobileHistoryRefreshStatus, MobileTodayCost } from '@/lib/mobile-dashboard-contract';
import { NextResponse } from 'next/server';
import { isTeslaAuthError } from '@/lib/tesla-client';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { Schedule, getCurrentTariffLabel } from '@/lib/schedule';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { formatSiteDate } from '@/lib/date-utils';
import { refreshLiveStatus, refreshTodayData, type RefreshTodayResult } from '@/lib/today-refresh';
import { readMobileHistoryRevision, type MobileHistoryRevision } from '@/lib/mobile-history-revision';
import { readCurrentMobileSite, readMobileBillConfiguration } from '@/lib/mobile-bill-revision';
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
// Token refresh, today's import, and an uncached cycle rollup can exceed 10s.
export const maxDuration = 60;
const MOBILE_ENERGY_STALE_AFTER_MS = 30 * 60 * 1000;
// One attempt per Tesla sample while history stays stale, including through an outage.
const MOBILE_STALE_RETRY_INTERVAL_MS = 5 * 60 * 1000;
// Leaves room for the rest of the route inside the app's 20-second request timeout.
const MOBILE_FORCED_IMPORT_TIMEOUT_MS = 10 * 1000;
// Tesla can take a while to publish the day's first sample. Past this, an empty day is overdue.
const MOBILE_EMPTY_DAY_GRACE_MS = 60 * 60 * 1000;
// The 60-second lease plus the client's short checks. A successful import keeps
// its claim stamp, and a failed one restores the earlier stamp.
const MOBILE_FOLLOWED_IMPORT_WINDOW_MS = 90 * 1000;

function latestToday(history: MobileHistoryRevision, midnight: Date) {
    return history.latest && history.latest >= midnight ? history.latest : null;
}

function refreshStatus(
    result: RefreshTodayResult['status'] | undefined, latest: Date | null, now: Date, midnight: Date
): MobileHistoryRefreshStatus {
    switch (result) {
        case 'persisted': return 'changed';
        case 'in-flight': return 'pending';
        case 'throttled': return 'throttled';
        case 'error':
        case 'connection-required':
        case 'no-tokens': return 'failed';
        default:
            if (latest && +now - +latest <= MOBILE_ENERGY_STALE_AFTER_MS) return 'current';
            return !latest && +now - +midnight > MOBILE_EMPTY_DAY_GRACE_MS ? 'overdue' : 'awaiting-data';
    }
}

function summaryRevision(
    site: NonNullable<Awaited<ReturnType<SiteRepo['getSite']>>>,
    history: MobileHistoryRevision,
    midnight: Date,
    cycleStart: Date,
    now: Date,
    currency: string | null
) {
    // The tariff period can advance without a new sample. Day and cycle
    // identity also change across midnight and billing boundaries.
    const active = new Schedule(site.tariffs, site.timezone).getTariffPeriod(now);
    return createHash('sha256').update(JSON.stringify([
        'mobile-summary-v1', site.id, site.name, site.timezone, +midnight, +cycleStart,
        history.revision, site.tariffs.map(tariff => tariff.id), active?.schedule.id, currency
    ])).digest('hex');
}

async function handleGET(request: Request) {
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

            setLogContext({ siteId });
            const siteRepo = new SiteRepo();

            const now = new Date();
            const mobileView = searchParams.get('view') === 'mobile';
            const historyCheck = mobileView && searchParams.get('historyCheck') === '1';
            const forceRefresh = mobileView && !historyCheck && searchParams.get('refresh') === '1';
            const { site, config: validConfig } = mobileView
                ? await readCurrentMobileSite(siteRepo, siteId)
                : { site: await siteRepo.getSite(siteId), config: null };
            const siteTimezone = site?.timezone ?? 'UTC';
            const siteMidnight = EnergyRepo.getSiteMidnight(now, siteTimezone);
            const cycleStart = getCurrentCycleStart(site?.billing_start_day || 1, now, siteTimezone);
            const scaleWindowHours = parseScaleWindowHours(process.env.SPARKLINE_SCALE_WINDOW_HOURS);
            const sparklineWindowStart = new Date(now.getTime() - (SPARKLINE_DISPLAY_WINDOW_HOURS * 60 * 60 * 1000));
            const sparklineScaleStart = mobileView
                ? siteMidnight
                : new Date(now.getTime() - (scaleWindowHours * 60 * 60 * 1000));
            const repo = createEnergyRepo(siteTimezone);
            const readRevision = (end: Date) => readMobileHistoryRevision(siteId, cycleStart, end, siteMidnight);
            // Read the lease before history, so a finished import's commit is visible.
            const followedImport = historyCheck ? siteRepo.getImportStatus(siteId) : null;
            const [liveResult, initialHistory, webHistoryRows] = await Promise.all([
                // A pull forces live-power first, so this cache already holds its reading.
                refreshLiveStatus(siteId, { cacheTtlMs: 60 * 1000 }),
                mobileView ? Promise.resolve(followedImport).then(() => readRevision(now)) : Promise.resolve(null),
                mobileView ? Promise.resolve(null) : repo.getBucketedEnergyData(siteId, sparklineScaleStart, now),
            ]);

            if (liveResult.status === 'connection-required' || liveResult.status === 'no-tokens') {
                return NextResponse.json({ error: 'Reconnect Tesla to update your data.', code: 'TESLA_CONNECTION_REQUIRED' }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } });
            }
            if (liveResult.status === 'site-not-found') {
                return NextResponse.json({ error: 'Site not found' }, { status: 404 });
            }
            if (!liveResult.liveStatus) {
                return NextResponse.json({ error: liveResult.errorMessage || 'Failed to fetch live status' }, { status: 500 });
            }

            const liveStatus = liveResult.liveStatus;
            const latestBefore = initialHistory && latestToday(initialHistory, siteMidnight);
            let result: RefreshTodayResult['status'] | undefined;
            let importDurationMs: number | undefined;
            let importError: string | undefined;
            let history = initialHistory;
            let historyIsCurrent = true;
            let historyEnd = now;
            if (initialHistory) {
                const isStale = !latestBefore || +now - +latestBefore > MOBILE_ENERGY_STALE_AFTER_MS;
                const followed = await followedImport;
                if (followed) {
                    if (followed.isImporting) {
                        result = 'in-flight';
                    } else if (isStale && +now - followed.lastImportAt > MOBILE_FOLLOWED_IMPORT_WINDOW_MS) {
                        result = 'error';
                        importError = 'The followed import released without recording success.';
                    }
                } else if (forceRefresh || isStale) {
                    const startedAt = Date.now();
                    try {
                        const refreshed = await refreshTodayData(siteId, forceRefresh
                            ? {
                                force: true,
                                timeoutMs: MOBILE_FORCED_IMPORT_TIMEOUT_MS,
                                ...(process.env.MOBILE_MANUAL_IMPORT_NO_COOLDOWN === 'true' ? { skipCooldown: true } : {}),
                            }
                            : { minIntervalMs: MOBILE_STALE_RETRY_INTERVAL_MS });
                        result = refreshed.status;
                        importError = refreshed.errorMessage;
                    } catch (error) {
                        result = 'error';
                        importError = error instanceof Error ? error.message : String(error);
                    } finally {
                        importDurationMs = Date.now() - startedAt;
                    }
                    // The import may have committed immediately before returning an
                    // error or while a concurrent caller was acquiring the lease.
                    const completedAt = new Date();
                    if (+EnergyRepo.getSiteMidnight(completedAt, siteTimezone) === +siteMidnight) {
                        historyEnd = completedAt;
                    }
                    try {
                        history = await readRevision(historyEnd);
                    } catch (error) {
                        // The stored history is still usable, but its revision may predate the import.
                        historyIsCurrent = false;
                        console.warn('[site-live-data] history revision reread failed:', error);
                    }
                }
            }
            const latestAfter = history && latestToday(history, siteMidnight);
            const historyStatus = refreshStatus(result, latestAfter, historyEnd, siteMidnight);
            if (mobileView) {
                logEvent(result === 'error' ? 'warn' : 'info', 'mobile.history.checked', {
                    manual: forceRefresh, followUp: historyCheck, outcome: historyStatus,
                    importResult: result ?? 'not-requested', importDurationMs, importError,
                    liveStatusAt: liveStatus.timestamp,
                    energyBefore: latestBefore?.toISOString() ?? null,
                    energyAfter: latestAfter?.toISOString() ?? null,
                });
            }
            const revision = site && history && historyIsCurrent && !history.hasFutureSamples && validConfig
                ? summaryRevision(site, history, siteMidnight, cycleStart, now, validConfig.currency)
                : undefined;
            if (revision && revision === searchParams.get('knownHistoryRevision')) {
                return new NextResponse(null, {
                    status: 304,
                    headers: { 'Cache-Control': 'private, no-store', 'X-PWUsage-History-Refresh': historyStatus },
                });
            }

            const todayDetail = mobileView ? await repo.getRawEnergyData(siteId, siteMidnight, historyEnd) : undefined;
            const historyRows = webHistoryRows
                ?? await repo.getBucketedEnergyData(siteId, sparklineScaleStart, historyEnd, todayDetail);
            const currentTariff = getCurrentTariffLabel(site, now);
            let todayRows = historyRows;
            let todayComplete = true;
            let todayGapFetched = false;
            let calculationsComplete = true;

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
                    const activePeriod = schedule.getTariffPeriod(now);
                    const activeName = activePeriod ? (activePeriod.schedule.name || 'Standard') : null;

                    if (activeName) {
                        const siteMidnight = EnergyRepo.getSiteMidnight(now, site!.timezone);
                        const cycleStart = getCurrentCycleStart(site!.billing_start_day, now, site!.timezone);
                        const tariffVersionKey = [
                            site!.tariffs.map(t => `${t.id}:${new Date(t.updated).getTime()}`).join(','),
                            history?.priorRevision ?? '',
                        ].join(':');

                        // On a DST fallback evening the local day is longer than
                        // the rolling sparkline window, so the head of today sits
                        // outside `historyRows`. Fetch only that sliver, only then.
                        const gap = missingTodayInterval(siteMidnight, sparklineScaleStart);

                        const [priorCycle, gapRows] = await Promise.all([
                            getCachedCycleRollup(
                                mobileView ? `mobile:${siteId}` : siteId, cycleStart, siteMidnight,
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
                calculationsComplete = false;
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
                    calculationsComplete = false;
                    console.warn('[site-live-data] today totals are incomplete:', gapError);
                }
            }

            // `now` predates the Tesla fetch above; a reading newer than it is not from the future.
            const readingsCheckedAt = new Date();
            const liveSourceMs = new Date(liveStatus.timestamp).getTime();
            const stateOfCharge = Number.isFinite(liveSourceMs)
                && readingsCheckedAt.getTime() - liveSourceMs >= 0
                && readingsCheckedAt.getTime() - liveSourceMs <= MOBILE_SOC_STALE_AFTER_MS
                ? liveStatus.percentage_charged
                : null;
            const liveSocUsable = typeof liveStatus.percentage_charged === 'number'
                && Number.isFinite(liveStatus.percentage_charged)
                && liveStatus.percentage_charged >= 0 && liveStatus.percentage_charged <= 100
                && Number.isFinite(liveSourceMs)
                && readingsCheckedAt.getTime() - liveSourceMs >= 0
                && readingsCheckedAt.getTime() - liveSourceMs <= MOBILE_SOC_MAX_AGE_MS;
            // Most responses use the already-fetched live cache. Only a missing
            // value incurs one small, indexed DB read; never fetch Tesla again.
            const fallbackSoc = mobileView && !liveSocUsable
                ? await repo.getLatestBatterySoc(siteId, new Date(readingsCheckedAt.getTime() - MOBILE_SOC_MAX_AGE_MS))
                : null;
            // Use canonical daily TOU netting, never bucket averages or the current rate.
            // Only the mobile response needs this; it adds no Tesla requests.
            let todayCost: MobileTodayCost | null = null;
            if (mobileView && (site?.tariffs?.length ?? 0) > 0) {
                try {
                    const [usage, currency] = await Promise.all([
                        repo.getUsageByTOU(siteId, siteMidnight, historyEnd, todayDetail),
                        validConfig ? Promise.resolve(validConfig.currency) : siteRepo.getSiteCurrencyCode(siteId),
                    ]);
                    if (usage.length > 0 && usage.every(item => item.touName !== 'Unknown'
                        && typeof item.cost === 'number' && Number.isFinite(item.cost))) {
                        const importCharges = usage.reduce((sum, item) => sum + Math.max(item.cost!, 0), 0);
                        const exportCredits = usage.reduce((sum, item) => sum + Math.max(-item.cost!, 0), 0);
                        if (Number.isFinite(importCharges) && Number.isFinite(exportCredits)) {
                            todayCost = { netCost: importCharges - exportCredits, importCharges, exportCredits, currency: currency || 'USD' };
                        }
                    }
                } catch (error) {
                    calculationsComplete = false;
                    console.warn('[site-live-data] daily cost unavailable:', error);
                }
            }
            const mobileContract = buildMobileDashboardContract({
                site: { id: siteId, name: site?.name ?? '', timezone: siteTimezone },
                live: liveStatus,
                fallbackSoc,
                energyTimestamp: maxBucketSampleTimestamp(historyRows),
                now: readingsCheckedAt,
                activeTariff: currentTariff,
                activeLoadTiming,
                today: sumBucketedTodayRows(todayRows, siteMidnight),
                todayComplete,
                todayCost,
                bill: null,
                todayDate: formatSiteDate(now, siteTimezone),
            });

            if (mobileView) {
                // A concurrent import or configuration edit during detail reads can
                // make the computed fields a mix of snapshots. Do not tag that result.
                let stableRevision: string | undefined;
                if (revision && history && calculationsComplete) {
                    try {
                        const [currentHistory, currentConfig] = await Promise.all([
                            readRevision(historyEnd), readMobileBillConfiguration(siteId),
                        ]);
                        if (currentHistory.revision === history.revision
                            && JSON.stringify(currentConfig) === JSON.stringify(validConfig)) stableRevision = revision;
                    } catch (error) {
                        // The summary is still usable; only its later reuse is lost.
                        console.warn('[site-live-data] revision check failed:', error);
                    }
                }
                return NextResponse.json({
                    ...mobileContract,
                    historyRefresh: { status: historyStatus },
                    ...(stableRevision ? { historyRevision: stableRevision } : {}),
                } satisfies typeof mobileContract, { headers: { 'Cache-Control': 'private, no-store' } });
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
                return NextResponse.json({ error: 'Reconnect Tesla to update your data.', code: 'TESLA_CONNECTION_REQUIRED' }, { status: 409 });
            }

            return NextResponse.json({ error: 'Failed to fetch site live data' }, { status: 500 });
        }
    });
}

export const GET = observeRoute('/api/site-live-data', handleGET);
