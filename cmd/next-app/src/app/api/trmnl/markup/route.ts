import { after, NextResponse } from 'next/server';
import { EnergyRepo, sumTodayRows } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { Schedule } from '@/lib/schedule';
import { Importer } from '@/lib/importer';
import { TeslaClient, EnergySiteLiveStatus } from '@/lib/tesla-client';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import QRCode from 'qrcode';
import { TrmnlRenderer } from '@/lib/trmnl-renderer';
import { computeLoadTiming } from '@/lib/load-timing';
import {
    DEFAULT_TRMNL_COMPONENT_CONFIG,
    extractTrmnlCarouselIndex,
    extractTrmnlComponentScreens,
    normalizeTrmnlComponentConfig
} from '@/lib/trmnl-component-config';
import { TrmnlInstallationRepo } from '@/lib/trmnl-installation-repo';
import { verifyTrmnlRequestAuth } from '@/lib/trmnl-auth';
import { continueUrl } from '@/app/continue/continue-logic';
import { getCurrentCycleStart } from '@/lib/billing-cycle';
import { addMonthsInSiteTimezone } from '@/lib/date-utils';
import { aggregateUsage } from '@/lib/tou-aggregation';
import { SiteService, getTeslaRefreshState, TeslaRefreshState } from '@/lib/site-service';

export const dynamic = 'force-dynamic';

const TRMNL_POLL_INTERVAL_MS = 15 * 60 * 1000;
const TESLA_REFRESH_MIN_INTERVAL_MS = 14 * 60 * 1000;
const SOC_STALE_AFTER_MS = 20 * 60 * 1000;
const TESLA_TODAY_TIMEOUT_MS = 8000;


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

            // Verify Bearer Token
            const authHeader = request.headers.get('Authorization');
            const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
            console.log(`[TrmnlMarkup] UUID: ${uuid}, has auth header: ${!!authHeader}, has token: ${!!token}, stored token exists: ${!!installation.access_token}`);

            const isAuthorized = token ? await verifyTrmnlRequestAuth(token, uuid, installation) : false;

            if (!isAuthorized) {
                console.warn(`[TrmnlMarkup] Unauthorized access attempt for UUID ${uuid}`);
                return getQrResponse(request, uuid, null, 'Plugin Auth Failed', 'Scan to Re-link');
            }

            const screens = extractTrmnlComponentScreens(installation.json);
            const currentIndex = extractTrmnlCarouselIndex(installation.json, screens.length);

            if (!componentConfigParam) {
                componentConfig = screens[currentIndex].componentConfig;

                const nextIndex = screens.length > 1 ? (currentIndex + 1) % screens.length : 0;
                if (installation.id && nextIndex !== currentIndex) {
                    const trmnlInstallationRepo = new TrmnlInstallationRepo();
                    const installationId = installation.id;
                    after(async () => {
                        try {
                            await trmnlInstallationRepo.updateCarouselIndex(installationId, nextIndex);
                        } catch (error) {
                            console.warn(`[TrmnlMarkup] Failed to advance carousel index for installation ${installationId}:`, error);
                        }
                    });
                }
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
        const start = getCurrentCycleStart(site.billing_start_day || 1, now, site.timezone);
        const cycleEnd = addMonthsInSiteTimezone(start, 1, site.timezone);


        // --- AUTH & CLIENT INIT ---
        const siteService = new SiteService({ siteRepo });
        const trmnlClient = await siteService.getTeslaClientForSite(site.id);


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

        const nowMs = Date.now();
        // Load live status cache or fetch inline via SiteService
        const liveInlineStart = Date.now();
        const liveStatus = await siteService.getLiveStatus(site.id) || undefined;
        const liveInlineMs = Date.now() - liveInlineStart;
        const liveInlineStatus = liveStatus ? 'success' : 'skipped_or_timeout';
        const hasCachedLiveStatus = !!liveStatus;
        const lastLiveRefreshAt = Number(site.last_live_refresh_at || 0);

        let fetchStatus = trmnlClient ? 'background-throttled' : 'skipped';
        let backgroundStatus = trmnlClient ? 'throttled' : 'skipped';

        const refreshState = getTeslaRefreshState(site.id);

        const shouldRefreshToday = trmnlClient
            ? !refreshState.todayInFlight && (nowMs - refreshState.lastTodayRefreshAt >= TESLA_REFRESH_MIN_INTERVAL_MS)
            : false;
        const shouldRefreshLive = trmnlClient
            ? !refreshState.liveInFlight && (nowMs - lastLiveRefreshAt >= TESLA_REFRESH_MIN_INTERVAL_MS)
            : false;

        // --- TESLA REFRESH (lifecycle-bound background) ---
        if (trmnlClient && (shouldRefreshToday || shouldRefreshLive)) {
            const importer = new Importer(trmnlClient);
            const siteId = site.id;
            backgroundStatus = 'started';
            fetchStatus = hasCachedLiveStatus ? 'cached+refreshing' : 'refreshing';

            if (shouldRefreshToday) {
                refreshState.todayInFlight = true;
                refreshState.lastTodayRefreshAt = Date.now();
            }
            if (shouldRefreshLive) {
                refreshState.liveInFlight = true;
                refreshState.lastLiveRefreshAt = Date.now();
            }

            const backgroundRefresh = async () => {
                try {
                    const tasks: Promise<void>[] = [];

                    if (shouldRefreshToday) {
                        tasks.push((async () => {
                            const lockId = crypto.randomUUID();
                            const acquired = await siteRepo.acquireImportLock({
                                siteId,
                                lockId,
                                lockDurationMs: 60000,
                                minIntervalMs: TESLA_REFRESH_MIN_INTERVAL_MS
                            });
                            if (!acquired) {
                                refreshState.todayInFlight = false;
                                return;
                            }
                            try {
                                const startMs = Date.now();
                                const rows = await withTimeout(importer.getTodayData(siteId), TESLA_TODAY_TIMEOUT_MS, 'tesla_today');
                                console.log(`[TrmnlMarkup] Tesla Today Usage Fetch (background): ${Date.now() - startMs}ms`);
                                // Drop strict pre-filter, let persistHistory do the job.
                                await importer.persistHistory(siteId, rows, latestTimestamp);
                            } catch (error) {
                                console.warn(`[TrmnlMarkup] Tesla today fetch failed (background):`, error);
                            } finally {
                                refreshState.todayInFlight = false;
                                try {
                                    await siteRepo.releaseImportLock(siteId, lockId);
                                } catch (err) {
                                    console.error(`[TrmnlMarkup] Failed to release DB import lock for site ${siteId}:`, err);
                                }
                            }
                        })());
                    }

                    if (shouldRefreshLive) {
                        tasks.push((async () => {
                            try {
                                const startMs = Date.now();
                                await siteService.refreshLiveStatus(siteId);
                                console.log(`[TrmnlMarkup] Tesla Live Status Fetch (background): ${Date.now() - startMs}ms`);
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
        const schedule = new Schedule(site.tariffs, tz);
        const { tariffGroups, totalBillCost, seriesData, latestSeriesSoc } = aggregateUsage(
            site,
            priorAggregates,
            todayRaw,
            schedule
        );
        aggregationMs = Date.now() - aggregationStart;

        const todayTotals = sumTodayRows(todayRaw);
        const todayHome = todayTotals.homeKwh;
        const todayGrid = todayTotals.gridNetKwh;
        const todaySolar = todayTotals.solarKwh;


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
        const liveStatusAgeMs = lastLiveRefreshAt > 0 ? Math.max(0, nowMs - lastLiveRefreshAt) : null;
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
            dateRange: `${start.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: tz })} - ${cycleEnd.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: tz })}`,
            tariffGroups: tariffGroups,
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
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (() => {
        const host = request.headers.get('host') || 'localhost:3000';
        const protocol = host.includes('localhost') ? 'http' : 'https';
        return `${protocol}://${host}`;
    })();
    const logoUrl = `${baseUrl}/apple-touch-icon.png`;
    // Route the device QR through the /continue gate. Scanning from the iOS
    // lock-screen / Control Center scanner opens links in a cookie-less,
    // ephemeral context, so a direct link to the (session-gated) manage/settings
    // page forces a futile re-auth every time. /continue forwards when a session
    // exists and otherwise tells the user to scan with the Camera app instead.
    const internalPath = uuid
        ? `/trmnl/manage?uuid=${encodeURIComponent(uuid)}`
        : `/site/${encodeURIComponent(siteId ?? '')}/settings`;
    const manageUrl = continueUrl(baseUrl, internalPath);

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
