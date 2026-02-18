import { after, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';


import { Importer } from '@/lib/importer';
import { TeslaClient, EnergySiteLiveStatus } from '@/lib/tesla-client';
import { verifySiteAccess } from '@/lib/auth-checks';
import QRCode from 'qrcode';
import { TrmnlRenderer } from '@/lib/trmnl-renderer';
import { wattsToKilowatts } from '@/lib/energy-utils';
import {
    extractTrmnlCarouselIndex,
    extractTrmnlComponentConfig,
    extractTrmnlComponentScreens,
    mergeTrmnlComponentScreensIntoInstallationJson,
    normalizeTrmnlComponentConfig
} from '@/lib/trmnl-component-config';
import { pool } from '@/lib/db';

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
    const routeStart = Date.now();
    try {
        const { searchParams } = new URL(request.url);
        const uuid = searchParams.get('uuid');
        const siteIdParam = searchParams.get('site_id');
        const componentConfigParam = searchParams.get('component_config');

        let installation: import('@/lib/db').TrmnlInstallation | null = null;
        let site: import('@/lib/db').SiteWithTariffs | null = null;
        const repo = new EnergyRepo();
        let componentConfig = extractTrmnlComponentConfig(null);

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
            const result = await repo.getInstallationAndSite(uuid);
            if (!result) {
                console.log(`[TrmnlMarkup] UUID ${uuid} not found. Generating setup QR code.`);
                return getQrResponse(request, uuid, 'Setup Required', 'Scan to Configure');
            }

            installation = result.installation;
            site = result.site;
            if (!componentConfigParam) {
                const screens = extractTrmnlComponentScreens(installation.json);
                const currentIndex = extractTrmnlCarouselIndex(installation.json, screens.length);
                componentConfig = screens[currentIndex]?.componentConfig ?? extractTrmnlComponentConfig(installation.json);

                const nextIndex = screens.length > 1 ? (currentIndex + 1) % screens.length : 0;
                if (installation.id && nextIndex !== currentIndex) {
                    const nextJson = mergeTrmnlComponentScreensIntoInstallationJson(installation.json ?? null, screens, nextIndex);
                    after(async () => {
                        try {
                            await pool.query('UPDATE "TrmnlInstallation" SET json = $1 WHERE id = $2', [nextJson, installation!.id]);
                        } catch (error) {
                            console.warn(`[TrmnlMarkup] Failed to advance carousel index for installation ${installation!.id}:`, error);
                        }
                    });
                }
            }

            // Verify Bearer Token
            const authHeader = request.headers.get('Authorization');
            if (installation.access_token && (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== installation.access_token)) {
                return getQrResponse(request, uuid, 'Plugin Auth Failed', 'Scan to Re-link');
            }

        } else if (siteIdParam) {
            if (!(await verifySiteAccess(siteIdParam))) {
                return NextResponse.json({ error: 'Unauthorized preview' }, { status: 401 });
            }
            site = await repo.getSite(siteIdParam) || null;
        } else {
            return NextResponse.json({ error: 'Missing uuid or site_id parameter' }, { status: 400 });
        }

        if (!site) {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        // --- TESLA AUTH CHECK (Revoked) ---
        if (site.auth_status === 'revoked') {
            console.warn(`[TrmnlMarkup] Tesla auth revoked for site ${site.id}. Showing re-auth QR code.`);
            return getQrResponse(request, uuid!, 'Tesla Auth Expired', 'Scan to Re-authenticate');
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

            const handlers = repo.getLockedRefreshHandler(site.id);
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
        let aggregationMs = 0;
        let renderMs = 0;

        const dbLatestPromise = (async () => {
            const startMs = Date.now();
            const res = await repo.getLatestEnergyData(site!.id);
            dbLatestMs = Date.now() - startMs;
            console.log(`[TrmnlMarkup] DB Latest Energy Lookup: ${dbLatestMs}ms`);
            return res;
        })();

        const dbCyclePromise = (async () => {
            const startMs = Date.now();
            const res = await repo.getRawEnergyData(site!.id, start, now);
            dbCycleMs = Date.now() - startMs;
            console.log(`[TrmnlMarkup] DB Cycle Fetch: ${dbCycleMs}ms`);
            return res;
        })();

        const [latestData, allCycleData] = await Promise.all([dbLatestPromise, dbCyclePromise]);
        const latestTimestamp = latestData?.timestamp ?? null;

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
            refreshState.lastLiveRefreshAt = Date.now();
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
        const tz = site.timezone || 'UTC';
        const todayStart = EnergyRepo.getSiteMidnight(now, tz);
        const schedule = new Schedule(site.tariffs, tz);
        const tariffMap = new Map<number, import('@/lib/db').Tariff>();
        site.tariffs.forEach(t => tariffMap.set(t.id, t));

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
        let todayGrid = 0;
        let todaySolar = 0;

        for (const row of allCycleData) {
            const ts = row.timestamp;
            const tp = schedule.getTariffPeriod(ts);

            // Extract today's points for the chart using site-local day boundary
            if (ts.getTime() >= todayStart.getTime()) {
                seriesData.push(row);
                todayGrid += row.grid_power;
                todaySolar += row.solar_power;
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

        // Convert today totals to kWh
        todayGrid = wattsToKilowatts(todayGrid);
        todaySolar = wattsToKilowatts(todaySolar);

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

            group.periods.push({
                touName: data.touName,
                label: data.label,
                home: data.homeUsage,
                grid: data.gridUsage,
                solar: data.solarProduction,
                battery: data.batteryChange,
                cost: data.cost
            });
        }

        // Calculate total cost for the summary
        let totalBillCost = 0;
        for (const data of aggregation.values()) {
            totalBillCost += data.cost;
        }

        const currency = '$'; // TODO: Settings
        const costStr = totalBillCost.toFixed(2);
        const isCredit = totalBillCost < 0;
        const displayCost = isCredit ? `+${currency}${Math.abs(totalBillCost).toFixed(2)}` : `${currency}${costStr}`;
        const costLabel = isCredit ? 'Total Credit' : 'Total Cost';

        // Check for active period (needed for highlighting current TOU)
        const currentPeriod = schedule.getTariffPeriod(new Date());
        const currentTouName = currentPeriod?.schedule.name;


        let batterySoc: number | null = null;
        let batteryStatus: 'charging' | 'discharging' | 'idle' = 'idle';

        const latestLiveStatus = liveStatus as EnergySiteLiveStatus | undefined;
        const liveStatusAgeMs = liveStatusEntry ? Math.max(0, nowMs - liveStatusEntry.fetchedAt) : null;
        const isSocStale = liveStatusAgeMs !== null && liveStatusAgeMs > SOC_STALE_AFTER_MS;
        if (latestLiveStatus) {
            if (!isSocStale && typeof latestLiveStatus.percentage_charged === 'number') {
                batterySoc = latestLiveStatus.percentage_charged;
            }
            const power = latestLiveStatus.battery_power || 0;
            if (power < -50) batteryStatus = 'charging';
            else if (power > 50) batteryStatus = 'discharging';
        }

        // Prepare Render Context

        let displayName = site.name || 'Powerwall';
        if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
            displayName += ' (Preview)';
        }

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
            todayGrid: todayGrid,
            todaySolar: todaySolar,
            seriesData: seriesData,
            componentConfig
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
            `mode:${componentConfig.batterySocMode}`
        ].join(',');

        const serverTiming = [
            `db_latest;dur=${dbLatestMs.toFixed(1)}`,
            `db_cycle;dur=${dbCycleMs.toFixed(1)}`,
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
}

export async function POST(request: Request) {
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
}

async function getQrResponse(request: Request, uuid: string, title: string, label: string) {
    const host = request.headers.get('host') || 'localhost:3000';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const manageUrl = `${protocol}://${host}/trmnl/manage?uuid=${uuid}`;

    // Generate QR Code
    const qrDataUrl = await QRCode.toDataURL(manageUrl, { margin: 2, width: 300 });

    const markup = `
        <div class="view view--full">
             <div class="layout layout--col layout--center" style="padding: 20px; text-align: center;">
                <span class="title title--small">${title}</span>
                <img src="${qrDataUrl}" style="width: 150px; height: 150px; margin: 10px auto; display: block;" />
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
