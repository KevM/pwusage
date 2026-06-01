import { after, NextResponse } from 'next/server';
import { EnergyRepo, sumTodayRows } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { TeslaTokenRepo } from '@/lib/tesla-token-repo';
import { Schedule } from '@/lib/schedule';


import { Importer } from '@/lib/importer';
import { TeslaClient, EnergySiteLiveStatus } from '@/lib/tesla-client';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import QRCode from 'qrcode';
import { TrmnlRenderer } from '@/lib/trmnl-renderer';
import { computeLoadTiming } from '@/lib/load-timing';
import { wattsToKilowatts } from '@/lib/energy-utils';
import {
    DEFAULT_TRMNL_COMPONENT_CONFIG,
    extractTrmnlCarouselIndex,
    extractTrmnlComponentScreens,
    mergeTrmnlComponentScreensIntoInstallationJson,
    normalizeTrmnlComponentConfig
} from '@/lib/trmnl-component-config';
import { TrmnlInstallationRepo } from '@/lib/trmnl-installation-repo';
import { verifyTrmnlToken } from '@/lib/trmnl-auth';

export const dynamic = 'force-dynamic';

interface LiveStatusCacheEntry {
    data: EnergySiteLiveStatus;
    fetchedAt: number;
    expiresAt: number;
}

interface TeslaRefreshState {
    todayInFlight: boolean;
    liveInFlight: boolean;
    lastTodayRefreshAt: number;
    lastLiveRefreshAt: number;
}

const TRMNL_POLL_INTERVAL_MS = 15 * 60 * 1000;
const TESLA_REFRESH_MIN_INTERVAL_MS = 14 * 60 * 1000;
const LIVE_STATUS_CACHE_TTL_MS = 16 * 60 * 1000;
const SOC_STALE_AFTER_MS = 20 * 60 * 1000;
const TESLA_TODAY_TIMEOUT_MS = 8000;
const TESLA_LIVE_TIMEOUT_MS = 3000;
const TESLA_LIVE_INLINE_TIMEOUT_MS = 900;

function getLiveStatusCache(): Map<string, LiveStatusCacheEntry> {
    const globalState = global as unknown as { trmnlLiveStatusCache?: Map<string, LiveStatusCacheEntry> };
    if (!globalState.trmnlLiveStatusCache) {
        globalState.trmnlLiveStatusCache = new Map<string, LiveStatusCacheEntry>();
    }
    return globalState.trmnlLiveStatusCache;
}

function getCachedLiveStatus(siteId: string): LiveStatusCacheEntry | undefined {
    const cache = getLiveStatusCache();
    const cached = cache.get(siteId);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
        cache.delete(siteId);
        return undefined;
    }
    return cached;
}

function setCachedLiveStatus(siteId: string, data: EnergySiteLiveStatus): void {
    const now = Date.now();
    getLiveStatusCache().set(siteId, {
        data,
        fetchedAt: now,
        expiresAt: now + LIVE_STATUS_CACHE_TTL_MS
    });
}

function getTeslaRefreshState(siteId: string): TeslaRefreshState {
    const globalState = global as unknown as { trmnlTeslaRefreshState?: Map<string, TeslaRefreshState> };
    if (!globalState.trmnlTeslaRefreshState) {
        globalState.trmnlTeslaRefreshState = new Map<string, TeslaRefreshState>();
    }
    const existing = globalState.trmnlTeslaRefreshState.get(siteId);
    if (existing) {
        return existing;
    }
    const initial: TeslaRefreshState = {
        todayInFlight: false,
        liveInFlight: false,
        lastTodayRefreshAt: 0,
        lastLiveRefreshAt: 0
    };
    globalState.trmnlTeslaRefreshState.set(siteId, initial);
    return initial;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function GET(request: Request) {
    return withRequestContext(async () => {
        const routeStart = Date.now();
        try {
        const { searchParams } = new URL(request.url);
        const uuid = searchParams.get('uuid');
        const siteIdParam = searchParams.get('site_id');
        const componentConfigParam = searchParams.get('component_config');

        let installation: import('@/lib/db').TrmnlInstallation | null = null;
        let site: import('@/lib/db').SiteWithTariffs | null = null;
        const siteRepo = new SiteRepo();
        const repo = new EnergyRepo();
        const tokenRepo = new TeslaTokenRepo(siteRepo);
        let componentConfig = { ...DEFAULT_TRMNL_COMPONENT_CONFIG };

        if (componentConfigParam) {
            if (!siteIdParam || uuid) {
                return NextResponse.json({ error: 'component_config override requires site_id preview mode' }, { status: 400 });
            }
            try {
                componentConfig = normalizeTrmnlComponentConfig(JSON.parse(componentConfigParam));
            } catch {
                return NextResponse.json({ error: 'Invalid component_config payload' }, { status: 400 });
            }
        }

        if (uuid) {
            const trmnlInstallationRepo = new TrmnlInstallationRepo();
            const result = await trmnlInstallationRepo.findByUuidWithSite(uuid, { includeTokens: true });
            if (!result) {
                console.log(`[TrmnlMarkup] UUID ${uuid} not found. Generating setup QR code.`);
                return getQrResponse(request, uuid, null, 'Setup Required', 'Scan to Configure');
            }

            installation = result.installation;
            site = result.site;
            if (!componentConfigParam) {
                const screens = extractTrmnlComponentScreens(installation.json);
                const currentIndex = extractTrmnlCarouselIndex(installation.json, screens.length);
                componentConfig = screens[currentIndex].componentConfig;

                const nextIndex = screens.length > 1 ? (currentIndex + 1) % screens.length : 0;
                if (installation.id && nextIndex !== currentIndex) {
                    const nextJson = mergeTrmnlComponentScreensIntoInstallationJson(installation.json ?? null, screens, nextIndex);
                    const trmnlInstallationRepo = new TrmnlInstallationRepo();
                    const installationId = installation.id;
                    after(async () => {
                        try {
                            await trmnlInstallationRepo.updateJson(installationId, nextJson);
                        } catch (error) {
                            console.warn(`[TrmnlMarkup] Failed to advance carousel index for installation ${installationId}:`, error);
                        }
                    });
                }
            }

            // Verify Bearer Token
            const authHeader = request.headers.get('Authorization');
            const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
            console.log(`[TrmnlMarkup] UUID: ${uuid}, has auth header: ${!!authHeader}, has token: ${!!token}, stored token exists: ${!!installation.access_token}`);

            let isAuthorized = false;
            if (installation.access_token) {
                isAuthorized = token === installation.access_token;
            } else if (token) {
                // Fallback: If no local access_token, verify via Trmnl JWT
                try {
                    await verifyTrmnlToken(token, uuid);
                    isAuthorized = true;
                } catch (err) {
                    console.warn(`[TrmnlMarkup] JWT Verification Failed for ${uuid}:`, err);
                }
            }

            if (!isAuthorized) {
                console.warn(`[TrmnlMarkup] Unauthorized access attempt for UUID ${uuid}`);
                return getQrResponse(request, uuid, null, 'Plugin Auth Failed', 'Scan to Re-link');
            }

        } else if (siteIdParam) {
            if (!(await verifySiteAccess(siteIdParam))) {
                return NextResponse.json({ error: 'Unauthorized preview' }, { status: 401 });
            }
            site = await siteRepo.getSite(siteIdParam, { includeTokens: true }) || null;
        } else {
            return NextResponse.json({ error: 'Missing uuid or site_id parameter' }, { status: 400 });
        }

        if (!site) {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        // --- TESLA AUTH CHECK (Revoked) ---
        if (site.auth_status === 'revoked') {
            console.warn(`[TrmnlMarkup] Tesla auth revoked for site ${site.id}. Showing re-auth QR code.`);
            return getQrResponse(request, uuid, site.id, 'Tesla Auth Expired', 'Scan to Re-authenticate');
        }

        // Calculate bill for current period using site-local time components
        const now = new Date();
        const siteLocalNowStr = now.toLocaleString('en-US', { timeZone: site.timezone, year: 'numeric', month: 'numeric', day: 'numeric' });
        const [mStr, dStr, yStr] = siteLocalNowStr.split('/');
        const siteYear = parseInt(yStr);
        const siteMonth = parseInt(mStr) - 1;
        const siteDate = parseInt(dStr);

        const billingStartDay = site.billing_start_day || 1;
        let billingYear = siteYear;
        let billingMonth = siteMonth;

        if (siteDate < billingStartDay) {
            billingMonth -= 1;
            if (billingMonth < 0) {
                billingMonth = 11;
                billingYear -= 1;
            }
        }

        // Construct a safe middle-of-day Date for the site to avoid UTC wrapping issues
        const billingStartPivot = new Date(Date.UTC(billingYear, billingMonth, billingStartDay, 12, 0, 0));
        const start = EnergyRepo.getSiteMidnight(billingStartPivot, site.timezone);

        // End is now (to show current usage)

        // Calculate Cycle End for Display (Start + 1 Month)
        const cycleEnd = new Date(start);
        cycleEnd.setMonth(cycleEnd.getMonth() + 1);

        // --- AUTH & CLIENT INIT ---
        let trmnlClient: TeslaClient | null = null;

        if (site.refresh_token) {
            console.log(`[Trmnl] Found refresh token for site ${site.id}, initializing client...`);
            const useToken = site.access_token || 'expired';

            const handlers = tokenRepo.getLockedRefreshHandler(site.id);
            trmnlClient = new TeslaClient({
                accessToken: useToken,
                refreshToken: site.refresh_token,
                tokenRefreshHandler: handlers.refreshHandler,
                onTokenError: handlers.errorHandler,
                onTokenUpdate: async () => {
                    console.log(`[Trmnl] Token update callback triggered for site ${site.id}`);
                }
            });
        } else {
            console.log(`[Trmnl] No refresh token found for site ${site.id}`);
        }

        // --- BLOCKING DATA FETCHES (DB only) ---
        let dbLatestMs = 0;
        let dbCycleMs = 0;
        let dbTodayMs = 0;
        let aggregationMs = 0;
        let renderMs = 0;

        const tz = site.timezone || 'UTC';
        const todayStart = EnergyRepo.getSiteMidnight(now, tz);

        const dbLatestPromise = (async () => {
            const startMs = Date.now();
            const res = await repo.getLatestEnergyData(site!.id);
            dbLatestMs = Date.now() - startMs;
            console.log(`[TrmnlMarkup] DB Latest Energy Lookup: ${dbLatestMs}ms`);
            return res;
        })();

        const dbCyclePromise = (async () => {
            const startMs = Date.now();
            const res = await repo.getCycleAggregates(site!.id, start, todayStart);
            dbCycleMs = Date.now() - startMs;
            console.log(`[TrmnlMarkup] DB Cycle Aggregates Fetch: ${dbCycleMs}ms`);
            return res;
        })();

        const dbTodayPromise = (async () => {
            const startMs = Date.now();
            const res = await repo.getRawEnergyData(site!.id, todayStart, now);
            dbTodayMs = Date.now() - startMs;
            console.log(`[TrmnlMarkup] DB Today Raw Fetch: ${dbTodayMs}ms`);
            return res;
        })();

        const [latestData, priorAggregates, todayRaw] = await Promise.all([dbLatestPromise, dbCyclePromise, dbTodayPromise]);
        const latestTimestamp = latestData?.timestamp ?? null;

        // Load timing needs the per-TOU cycle UsageData. Only fetch it when the
        // section is enabled — zero added DB cost when the feature is off.
        const loadTimingCycle = componentConfig.showLoadTiming
            ? await repo.getUsageByTOU(site!.id, start, now)
            : [];

        let liveStatusEntry = getCachedLiveStatus(site.id);
        let liveStatus: EnergySiteLiveStatus | undefined = liveStatusEntry?.data;
        let hasCachedLiveStatus = Boolean(liveStatus);
        const nowMs = Date.now();
        let fetchStatus = trmnlClient ? 'background-throttled' : 'skipped';
        let backgroundStatus = trmnlClient ? 'throttled' : 'skipped';
        let liveInlineMs = 0;
        let liveInlineStatus = 'skipped';

        const refreshState = getTeslaRefreshState(site.id);

        // On cache miss, do a short inline live-status fetch to avoid blank SoC on this response.
        if (trmnlClient && !liveStatus) {
            refreshState.liveInFlight = true;
            try {
                const liveInlineStart = Date.now();
                const inlineLive = await withTimeout(trmnlClient.getLiveStatus(site.id), TESLA_LIVE_INLINE_TIMEOUT_MS, 'tesla_live_inline');
                liveInlineMs = Date.now() - liveInlineStart;
                liveInlineStatus = 'success';
                setCachedLiveStatus(site.id, inlineLive);
                liveStatusEntry = getCachedLiveStatus(site.id);
                liveStatus = inlineLive;
                hasCachedLiveStatus = true;
                fetchStatus = 'live-inline';
                refreshState.lastLiveRefreshAt = Date.now();
            } catch (error) {
                if (error instanceof Error && error.message === 'tesla_live_inline_timeout') {
                    liveInlineStatus = 'timeout';
                    fetchStatus = 'inline-timeout';
                    console.info('[TrmnlMarkup] Inline live status fetch timed out; continuing with stale-while-refresh.');
                } else {
                    liveInlineStatus = 'error';
                    console.warn('[TrmnlMarkup] Inline live status fetch failed:', error);
                }
            } finally {
                refreshState.liveInFlight = false;
            }
        }

        const shouldRefreshToday = trmnlClient
            ? !refreshState.todayInFlight && (nowMs - refreshState.lastTodayRefreshAt >= TESLA_REFRESH_MIN_INTERVAL_MS)
            : false;
        const shouldRefreshLive = trmnlClient
            ? !refreshState.liveInFlight && (nowMs - refreshState.lastLiveRefreshAt >= TESLA_REFRESH_MIN_INTERVAL_MS)
            : false;

        // --- TESLA REFRESH (lifecycle-bound background) ---
        if (trmnlClient && (shouldRefreshToday || shouldRefreshLive)) {
            const importer = new Importer(trmnlClient);
            const siteId = site.id;
            backgroundStatus = 'started';
            fetchStatus = hasCachedLiveStatus ? 'cached+refreshing' : 'refreshing';

            const backgroundRefresh = async () => {
                try {
                    const tasks: Promise<void>[] = [];

                    if (shouldRefreshToday) {
                        refreshState.todayInFlight = true;
                        refreshState.lastTodayRefreshAt = Date.now();
                        tasks.push((async () => {
                            try {
                                const startMs = Date.now();
                                const rows = await withTimeout(importer.getTodayData(siteId), TESLA_TODAY_TIMEOUT_MS, 'tesla_today');
                                console.log(`[TrmnlMarkup] Tesla Today Usage Fetch (background): ${Date.now() - startMs}ms`);
                                if (rows.length === 0) return;
                                const missingRows = rows.filter(row => !latestTimestamp || row.timestamp.getTime() > latestTimestamp.getTime());
                                if (missingRows.length > 0) {
                                    await importer.persistHistory(siteId, missingRows, latestTimestamp);
                                }
                            } catch (error) {
                                console.warn(`[TrmnlMarkup] Tesla today fetch failed (background):`, error);
                            } finally {
                                refreshState.todayInFlight = false;
                            }
                        })());
                    }

                    if (shouldRefreshLive) {
                        refreshState.liveInFlight = true;
                        refreshState.lastLiveRefreshAt = Date.now();
                        tasks.push((async () => {
                            try {
                                const startMs = Date.now();
                                const status = await withTimeout(trmnlClient!.getLiveStatus(siteId), TESLA_LIVE_TIMEOUT_MS, 'tesla_live');
                                console.log(`[TrmnlMarkup] Tesla Live Status Fetch (background): ${Date.now() - startMs}ms`);
                                setCachedLiveStatus(siteId, status);
                            } catch (error) {
                                console.warn(`[TrmnlMarkup] Tesla live status fetch failed (background):`, error);
                            } finally {
                                refreshState.liveInFlight = false;
                            }
                        })());
                    }

                    await Promise.all(tasks);
                } catch (error) {
                    console.error(`[TrmnlMarkup] Background Tesla refresh failed:`, error);
                }
            };
            after(backgroundRefresh);
        } else if (hasCachedLiveStatus) {
            fetchStatus = 'cached';
        }

        // --- IN-MEMORY AGGREGATION (TOU Stats & Chart Extraction) ---
        const aggregationStart = Date.now();

        // Determine site-local "today" window once, then use numeric boundary checks per row
        const schedule = new Schedule(site.tariffs, tz);
        const tariffMap = new Map<number, import('@/lib/db').Tariff>();
        const scheduleMap = new Map<number, import('@/lib/db').TariffSchedule>();
        site.tariffs.forEach(t => {
            tariffMap.set(t.id, t);
            if (t.seasons) {
                t.seasons.forEach(season => {
                    if (season.schedules) {
                        season.schedules.forEach(s => scheduleMap.set(s.id, s));
                    }
                });
            }
        });

        const aggregation = new Map<string, {
            tariff: import('@/lib/db').Tariff;
            tariffName: string;
            touName: string;
            label: string;
            homeUsage: number;
            gridUsage: number;
            solarProduction: number;
            batteryChange: number;
            cost: number;
            buyRate: number;
            sellRate: number;
        }>();
        const touLabelCache = new Map<string, string>();
        const getTouLabel = (name: string): string => {
            const cached = touLabelCache.get(name);
            if (cached) return cached;
            const label = (name || 'Standard')
                .replace(/_/g, ' ')
                .toLowerCase()
                .replace(/\b\w/g, c => c.toUpperCase())
                .replace(' ', '-');
            touLabelCache.set(name, label);
            return label;
        };
        const scheduleKeyCache = new WeakMap<object, string>();
        const fallbackKeyCache = new Map<number, string>();

        const seriesData: import('@/lib/db').EnergyData[] = [];
        // Today's scalar totals come from the canonical helper so this route
        // and the live page never disagree on "today so far". Computed on the
        // same `todayRaw` rows we use for per-period aggregation below.
        const todayTotals = sumTodayRows(todayRaw);
        const todayHome = todayTotals.homeKwh;
        const todayGrid = todayTotals.gridNetKwh;
        const todaySolar = todayTotals.solarKwh;
        let latestSeriesSoc: { value: number; timestamp: Date } | null = null;

        // Pass 1: Prior day aggregates
        for (const row of priorAggregates) {
            let touName = 'Unknown';
            let tariffName = 'Unknown';
            let buyRate = 0;
            let sellRate = 0;
            let currentTariff = site.tariffs[0];

            if (row.tariff_schedule_id != null) {
                // Look up the schedule by its ID (populated by insertEnergyData with corrected logic)
                const sched = scheduleMap.get(row.tariff_schedule_id);
                if (sched) {
                    touName = sched.name || 'Standard';
                    buyRate = sched.buy_rate || 0;
                    sellRate = sched.sell_rate || 0;
                }
            } else {
                // Fallback: tariff_schedule_id is null (old data or no matching period).
                // Recalculate using the midpoint of the aggregated day.
                const tp = schedule.getTariffPeriod(row.day);
                if (tp) {
                    touName = tp.schedule.name || 'Standard';
                    buyRate = tp.schedule.buy_rate || 0;
                    sellRate = tp.schedule.sell_rate || 0;
                }
            }
            const t = tariffMap.get(row.tariff_id);
            if (t) {
                tariffName = t.name || 'Unknown';
                currentTariff = t;
            }

            const key = `${currentTariff.id}|${touName}|${buyRate}|${sellRate}`;
            let data = aggregation.get(key);
            if (!data) {
                data = {
                    tariff: currentTariff,
                    tariffName: tariffName,
                    touName: touName,
                    label: getTouLabel(touName),
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    cost: 0,
                    buyRate,
                    sellRate
                };
                aggregation.set(key, data);
            }

            data.homeUsage += row.load_power;
            data.gridUsage += row.grid_power;
            data.solarProduction += row.solar_power;
            data.batteryChange += row.battery_power;
        }

        // Pass 2: Today's raw rows
        for (const row of todayRaw) {
            const ts = row.timestamp;
            const tp = schedule.getTariffPeriod(ts);

            seriesData.push(row);
            if (typeof row.battery_soc === 'number') {
                latestSeriesSoc = { value: row.battery_soc, timestamp: ts };
            }

            let touName = 'Unknown';
            let tariffName = 'Unknown';
            let buyRate = 0;
            let sellRate = 0;
            let currentTariff = site.tariffs[0];
            let key = '';

            if (tp) {
                touName = tp.schedule.name || 'Standard';
                tariffName = tp.tariff.name || 'Unknown';
                buyRate = tp.schedule.buy_rate || 0;
                sellRate = tp.schedule.sell_rate || 0;
                currentTariff = tp.tariff;
                const scheduleObj = tp.schedule as unknown as object;
                const cachedKey = scheduleKeyCache.get(scheduleObj);
                if (cachedKey) {
                    key = cachedKey;
                } else {
                    key = `${currentTariff.id}|${touName}|${buyRate}|${sellRate}`;
                    scheduleKeyCache.set(scheduleObj, key);
                }
            } else {
                const t = tariffMap.get(row.tariff_id);
                if (t) {
                    tariffName = t.name || 'Unknown';
                    currentTariff = t;
                }
                const cachedFallbackKey = fallbackKeyCache.get(currentTariff.id);
                if (cachedFallbackKey) {
                    key = cachedFallbackKey;
                } else {
                    key = `${currentTariff.id}|${touName}|${buyRate}|${sellRate}`;
                    fallbackKeyCache.set(currentTariff.id, key);
                }
            }

            let data = aggregation.get(key);
            if (!data) {
                data = {
                    tariff: currentTariff,
                    tariffName: tariffName,
                    touName: touName,
                    label: getTouLabel(touName),
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    cost: 0,
                    buyRate,
                    sellRate
                };
                aggregation.set(key, data);
            }

            data.homeUsage += row.load_power;
            data.gridUsage += row.grid_power;
            data.solarProduction += row.solar_power;
            data.batteryChange += row.battery_power;
        }
        aggregationMs = Date.now() - aggregationStart;

        // Compute each period cost from NET grid usage so displayed Grid and Cost stay consistent.
        for (const data of aggregation.values()) {
            const gridKwh = wattsToKilowatts(data.gridUsage);
            if (gridKwh >= 0) {
                data.cost = gridKwh * Math.abs(data.buyRate);
            } else {
                data.cost = -Math.abs(gridKwh) * Math.abs(data.sellRate);
            }
        }

        // (today totals already in kWh via sumTodayRows above)

        // Group by tariff for the renderer
        const tariffGroups = new Map<string, {
            tariffId: number;
            tariffName: string;
            periods: {
                touName: string;
                label: string;
                home: number;
                grid: number;
                solar: number;
                battery: number;
                cost: number;
            }[];
        }>();

        for (const data of aggregation.values()) {
            let group = tariffGroups.get(data.tariffName);
            if (!group) {
                group = { tariffId: data.tariff.id, tariffName: data.tariffName, periods: [] };
                tariffGroups.set(data.tariffName, group);
            }

            let period = group.periods.find(p => p.touName === data.touName);
            if (!period) {
                period = {
                    touName: data.touName,
                    label: data.label,
                    home: 0,
                    grid: 0,
                    solar: 0,
                    battery: 0,
                    cost: 0
                };
                group.periods.push(period);
            }

            period.home += data.homeUsage;
            period.grid += data.gridUsage;
            period.solar += data.solarProduction;
            period.battery += data.batteryChange;
            period.cost += data.cost;
        }

        // Calculate total cost for the summary
        let totalBillCost = 0;
        for (const data of aggregation.values()) {
            totalBillCost += data.cost;
        }

        const siteInfo = site.json as import('@/lib/tesla-client').EnergySiteInfo | null;
        const currencyCode = siteInfo?.tariff_content_v2?.currency || 'USD';
        let currency = '$';
        if (currencyCode === 'GBP') {
            currency = '£';
        } else if (currencyCode === 'EUR') {
            currency = '€';
        }

        const costStr = totalBillCost.toFixed(2);
        const isCredit = totalBillCost < 0;
        const displayCost = isCredit ? `+${currency}${Math.abs(totalBillCost).toFixed(2)}` : `${currency}${costStr}`;
        const costLabel = isCredit ? 'Total Credit' : 'Total Cost';

        // Check for active period (needed for highlighting current TOU)
        const currentPeriod = schedule.getTariffPeriod(new Date());
        const currentTouName = currentPeriod?.schedule.name;

        const loadTimingActive = currentPeriod
            ? {
                name: currentPeriod.schedule.name ?? 'Unknown',
                buyRate: currentPeriod.schedule.buy_rate ?? 0,
                sellRate: currentPeriod.schedule.sell_rate ?? 0
            }
            : null;
        const loadTimingView = componentConfig.showLoadTiming
            ? computeLoadTiming(schedule, loadTimingCycle, now, tz, loadTimingActive)
            : undefined;


        let batterySoc: number | null = null;
        let batteryStatus: 'charging' | 'discharging' | 'idle' = 'idle';

        const latestLiveStatus = liveStatus as EnergySiteLiveStatus | undefined;
        const liveStatusAgeMs = liveStatusEntry ? Math.max(0, nowMs - liveStatusEntry.fetchedAt) : null;
        const isSocStale = liveStatusAgeMs !== null && liveStatusAgeMs > SOC_STALE_AFTER_MS;
        const isFresh = (ts: Date | null | undefined): ts is Date => {
            if (!ts) return false;
            const ageMs = nowMs - ts.getTime();
            return ageMs >= 0 && ageMs <= SOC_STALE_AFTER_MS;
        };
        const latestDbSocFromLatestRow = (
            typeof latestData?.batterySoc === 'number' &&
            isFresh(latestTimestamp)
        ) ? latestData.batterySoc : null;
        const latestDbSocFromSeries = (
            latestSeriesSoc !== null &&
            isFresh(latestSeriesSoc.timestamp)
        ) ? latestSeriesSoc.value : null;

        if (latestLiveStatus) {
            if (!isSocStale && typeof latestLiveStatus.percentage_charged === 'number') {
                batterySoc = latestLiveStatus.percentage_charged;
            }
            const power = latestLiveStatus.battery_power || 0;
            if (power < -50) batteryStatus = 'charging';
            else if (power > 50) batteryStatus = 'discharging';
        }
        if (batterySoc === null && typeof latestDbSocFromLatestRow === 'number') {
            batterySoc = latestDbSocFromLatestRow;
        } else if (batterySoc === null && typeof latestDbSocFromSeries === 'number') {
            batterySoc = latestDbSocFromSeries;
        }

        // Prepare Render Context

        let displayName = site.name || 'Powerwall';
        if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
            displayName += ' (Preview)';
        }
        const timeString = now.toLocaleTimeString('en-US', {
            timeZone: tz,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        }).toLowerCase().replace(/\s+/g, '');
        displayName = `${displayName} @ ${timeString}`;

        const renderCtx = {
            siteName: displayName,
            dateRange: `${start.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })} - ${cycleEnd.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}`,
            tariffGroups: Array.from(tariffGroups.values()),
            totalCost: totalBillCost,
            costLabel: costLabel,
            displayCost: displayCost,
            currency: currency,
            currentTouName: currentTouName || undefined,
            batterySoc: batterySoc,
            batteryStatus: batteryStatus,
            todayHome: todayHome,
            todayGrid: todayGrid,
            todaySolar: todaySolar,
            seriesData: seriesData,
            timezone: tz,
            componentConfig,
            loadTiming: loadTimingView
        };

        const layoutStart = Date.now();
        const markupFull = TrmnlRenderer.renderFull(renderCtx);
        const markupHalfVertical = TrmnlRenderer.renderHalfVertical(renderCtx);
        const markupHalfHorizontal = TrmnlRenderer.renderHalfHorizontal(renderCtx);
        const markupQuadrant = TrmnlRenderer.renderQuadrant(renderCtx);
        renderMs = Date.now() - layoutStart;
        console.log(`[TrmnlMarkup] Rendering Logic: ${renderMs}ms`);

        const totalMs = Date.now() - routeStart;
        console.log(`[TrmnlMarkup] Total Route Logic: ${totalMs}ms`);

        const dataAgeMinutes = latestTimestamp
            ? ((nowMs - latestTimestamp.getTime()) / 60000).toFixed(1)
            : 'none';
        const socAgeMinutes = liveStatusAgeMs !== null
            ? (liveStatusAgeMs / 60000).toFixed(1)
            : 'none';
        const socAgeHeader = isSocStale ? `stale:${socAgeMinutes}` : socAgeMinutes;
        const componentDebug = [
            `lg:${componentConfig.showLiveGrid ? 1 : 0}`,
            `lso:${componentConfig.showLiveSolar ? 1 : 0}`,
            `lb:${componentConfig.showLiveBattery ? 1 : 0}`,
            `ec:${componentConfig.showEnergyChart ? 1 : 0}`,
            `soc:${componentConfig.showBatterySoc ? 1 : 0}`,
            `bill:${componentConfig.showEstimatedBill ? 1 : 0}`,
            `lt:${componentConfig.showLoadTiming ? 1 : 0}`,
            `mode:${componentConfig.batterySocMode}`
        ].join(',');

        const serverTiming = [
            `db_latest;dur=${dbLatestMs.toFixed(1)}`,
            `db_cycle;dur=${dbCycleMs.toFixed(1)}`,
            `db_today;dur=${dbTodayMs.toFixed(1)}`,
            `aggregate;dur=${aggregationMs.toFixed(1)}`,
            `render;dur=${renderMs.toFixed(1)}`,
            `total;dur=${totalMs.toFixed(1)}`,
            `live_inline;dur=${liveInlineMs.toFixed(1)};desc="${liveInlineStatus}"`,
            `live_cache;desc="${hasCachedLiveStatus ? 'hit' : 'miss'}"`,
            `tesla_bg;desc="${backgroundStatus}"`,
            `trmnl_poll;dur=${TRMNL_POLL_INTERVAL_MS}`
        ].join(', ');

        const response = NextResponse.json({
            markup: markupFull,
            markup_half_vertical: markupHalfVertical,
            markup_half_horizontal: markupHalfHorizontal,
            markup_quadrant: markupQuadrant
        }, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Surrogate-Control': 'no-store',
                'Server-Timing': serverTiming,
                'X-Debug-Live-Status': fetchStatus,
                'X-Debug-Battery-SOC': batterySoc !== null ? String(batterySoc) : 'null',
                'X-Data-Age-Minutes': dataAgeMinutes,
                'X-SOC-Age-Minutes': socAgeHeader,
                'X-Component-Config': componentDebug
            }
        });

        return response;


        } catch (error) {
            console.error('Markup error:', error);
            return NextResponse.json({ error: (error as Error).message }, { status: 500 });
        }
    });
}

export async function POST(request: Request) {
    return withRequestContext(async () => {
        let uuid = new URL(request.url).searchParams.get('uuid');

        if (!uuid) {
            try {
                const clone = request.clone();
                const contentType = request.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const body = await clone.json();
                    uuid = body.uuid || body.user_uuid;
                } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
                    const formData = await clone.formData();
                    uuid = (formData.get('uuid') || formData.get('user_uuid')) as string;
                }
            } catch {
                console.log('[TrmnlMarkup] Failed to parse POST body');
            }
        }

        if (uuid) {
            const url = new URL(request.url);
            url.searchParams.set('uuid', uuid);
            return GET(new Request(url.toString(), request));
        }



        // If we still don't have UUID, return error BUT with 400 so client knows
        return NextResponse.json({ error: 'Missing uuid parameter' }, { status: 400 });
    });
}

async function getQrResponse(request: Request, uuid: string | null, siteId: string | null, title: string, label: string) {
    const host = request.headers.get('host') || 'localhost:3000';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const logoUrl = `${protocol}://${host}/apple-touch-icon.png`;
    const manageUrl = uuid
        ? `${protocol}://${host}/trmnl/manage?uuid=${uuid}`
        : `${protocol}://${host}/site/${siteId}/settings`;

    // Generate QR Code with High error correction ('H') to support the centered logo overlay
    const qrDataUrl = await QRCode.toDataURL(manageUrl, { 
        margin: 2, 
        width: 300,
        errorCorrectionLevel: 'H'
    });

    const markup = `
        <div class="view view--full">
             <div class="layout layout--col layout--center" style="padding: 20px; text-align: center;">
                <span class="title title--small">${title}</span>
                <div style="position: relative; width: 150px; height: 150px; margin: 10px auto;">
                    <img src="${qrDataUrl}" style="width: 150px; height: 150px; display: block;" />
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 28px; height: 28px; background-color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                        <img src="${logoUrl}" style="width: 22px; height: 22px; border-radius: 50%;" />
                    </div>
                </div>
                <span class="label">${label}</span>
             </div>
        </div>
     `;

    return NextResponse.json({
        markup: markup,
        markup_half_vertical: markup,
        markup_half_horizontal: markup,
        markup_quadrant: markup
    }, {
        headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Surrogate-Control': 'no-store'
        }
    });
}
