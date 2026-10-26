import { logEvent, observeRoute, setLogContext } from '@/lib/observability';
import {readBillingAvailability} from '@/lib/billing-availability';
import { after, NextResponse } from 'next/server';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { EnergyRepo, sumTodayRows } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { Schedule } from '@/lib/schedule';
import { EnergySiteLiveStatus } from '@/lib/tesla-client';
import { refreshTodayData, refreshLiveStatus } from '@/lib/today-refresh';
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
import { getCurrentCycleStart, getNextCycleStart } from '@/lib/billing-cycle';
import { aggregateUsage } from '@/lib/tou-aggregation';
import { TariffRepo } from '@/lib/tariff-repo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TRMNL_POLL_INTERVAL_MS = 15 * 60 * 1000;
const TESLA_REFRESH_MIN_INTERVAL_MS = 14 * 60 * 1000;
const LIVE_STATUS_CACHE_TTL_MS = 16 * 60 * 1000;
const SOC_STALE_AFTER_MS = 20 * 60 * 1000;

async function handleGET(request: Request) {
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

        setLogContext({ siteId: site.id });

        // --- TESLA AUTH CHECK (Revoked) ---
        if (site.auth_status === 'revoked') {
            logEvent('warn', 'trmnl.auth-required', { siteId: site.id });
            return getQrResponse(request, uuid, site.id, 'Tesla Auth Expired', 'Scan to Re-authenticate');
        }

        // Calculate bill for current period using site-local time components
        const now = new Date();
        const start = getCurrentCycleStart(site.billing_start_day || 1, now, site.timezone);
        const cycleEnd = getNextCycleStart(site.billing_start_day || 1, start, site.timezone);

        const hasTeslaTokens = !!site.refresh_token;

        // --- BLOCKING DATA FETCHES (DB only) ---
        let dbLatestMs = 0;
        let dbCycleMs = 0;
        let dbTodayMs = 0;
        let aggregationMs = 0;
        let renderMs = 0;

        const tz = site.timezone || 'UTC';
        const repo = createEnergyRepo(tz);
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
            const res = await readBillingAvailability(()=>repo.getCycleAggregates(site!.id, start, todayStart),[]);
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

        const tariffRepo = new TariffRepo();
        const [latestData, billing, todayRaw, allTariffVersions, allScheduleVersions, currencyCode] = await Promise.all([
            dbLatestPromise,
            dbCyclePromise,
            dbTodayPromise,
            tariffRepo.getTariffsForSite(site!.id),
            tariffRepo.getSchedulesForSite(site!.id),
            siteRepo.getSiteCurrencyCode(site!.id),
        ]);
        const priorAggregates=billing.value;
        const billingAvailable=billing.status==='complete';
        const latestTimestamp = latestData?.timestamp ?? null;

        const schedule = new Schedule(site.tariffs, tz);

        // Load timing needs the per-TOU cycle UsageData. The rows and tariff
        // versions are already fetched above, so this aggregates in memory
        // instead of re-running the same queries via getUsageByTOU.
        const loadTimingCycle = componentConfig.showLoadTiming && billingAvailable
            ? EnergyRepo.aggregateUsageByTOU({
                siteId: site.id,
                start,
                priorAggregates,
                todayRaw,
                schedule,
                ...EnergyRepo.buildTariffLookupMaps(site.tariffs, allTariffVersions, allScheduleVersions),
            })
            : [];

        // Load live status cache from the Site record
        let liveStatus: EnergySiteLiveStatus | undefined = undefined;
        let lastLiveRefreshAt = 0;
        let hasCachedLiveStatus = false;
        const nowMs = Date.now();

        if (site.live_status_cache) {
            const cachedAgeMs = nowMs - Number(site.last_live_refresh_at || 0);
            if (cachedAgeMs < LIVE_STATUS_CACHE_TTL_MS) {
                liveStatus = site.live_status_cache as EnergySiteLiveStatus;
                hasCachedLiveStatus = true;
            }
            lastLiveRefreshAt = Number(site.last_live_refresh_at || 0);
        }

        let fetchStatus = hasTeslaTokens ? 'background-throttled' : 'skipped';
        let backgroundStatus = hasTeslaTokens ? 'throttled' : 'skipped';
        let liveInlineMs = 0;
        let liveInlineStatus = 'skipped';

        // On cache miss, do a short inline live-status fetch to avoid blank SoC on this response.
        if (hasTeslaTokens && !liveStatus) {
            try {
                const liveInlineStart = Date.now();
                const inlineResult = await refreshLiveStatus(site.id, {
                    timeoutMs: 900,
                    useCached: false,
                });
                liveInlineMs = Date.now() - liveInlineStart;
                if (inlineResult.status === 'refreshed' && inlineResult.liveStatus) {
                    liveInlineStatus = 'success';
                    liveStatus = inlineResult.liveStatus;
                    hasCachedLiveStatus = true;
                    fetchStatus = 'live-inline';
                    lastLiveRefreshAt = inlineResult.fetchedAt ?? Date.now();
                } else if (inlineResult.errorMessage?.includes('timeout')) {
                    liveInlineStatus = 'timeout';
                    fetchStatus = 'inline-timeout';
                    logEvent('info', 'trmnl.live-refresh.timed-out', { siteId: site.id });
                } else {
                    liveInlineStatus = 'error';
                    logEvent('warn', 'trmnl.live-refresh.failed', { siteId: site.id, outcome: inlineResult.status });
                }
            } catch (error) {
                liveInlineStatus = 'error';
                logEvent('warn', 'trmnl.live-refresh.threw', { siteId: site.id, error });
            }
        }

        // --- TESLA REFRESH (lifecycle-bound background) ---
        if (hasTeslaTokens) {
            const siteId = site.id;
            backgroundStatus = 'started';
            fetchStatus = hasCachedLiveStatus ? 'cached+refreshing' : 'refreshing';

            after(async () => {
                try {
                    await Promise.all([
                        refreshTodayData(siteId, { minIntervalMs: TESLA_REFRESH_MIN_INTERVAL_MS, timeoutMs: 8000 }),
                        refreshLiveStatus(siteId, { cacheTtlMs: TESLA_REFRESH_MIN_INTERVAL_MS, timeoutMs: 3000 }),
                    ]);
                } catch (error) {
                    logEvent('error', 'trmnl.background-refresh.failed', { siteId, error });
                }
            });
        } else if (hasCachedLiveStatus) {
            fetchStatus = 'cached';
        }

        // --- IN-MEMORY AGGREGATION (TOU Stats & Chart Extraction) ---
        const aggregationStart = Date.now();
        const { tariffGroups, totalBillCost, seriesData, latestSeriesSoc } = aggregateUsage(
            site,
            priorAggregates,
            todayRaw,
            schedule,
            allTariffVersions,
            allScheduleVersions
        );
        aggregationMs = Date.now() - aggregationStart;

        const todayTotals = sumTodayRows(todayRaw);
        const todayHome = todayTotals.homeKwh;
        const todayGrid = todayTotals.gridNetKwh;
        const todaySolar = todayTotals.solarKwh;


        let currency = '$';
        if (currencyCode === 'GBP') {
            currency = '£';
        } else if (currencyCode === 'EUR') {
            currency = '€';
        }

        const costStr = totalBillCost.toFixed(2);
        const isCredit = totalBillCost < 0;
        const displayCost = !billingAvailable ? '--' : isCredit ? `+${currency}${Math.abs(totalBillCost).toFixed(2)}` : `${currency}${costStr}`;
        const costLabel = !billingAvailable ? 'Pricing unavailable' : isCredit ? 'Total Credit' : 'Total Cost';

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
        const loadTimingView = componentConfig.showLoadTiming && billingAvailable
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
            tariffGroups: billingAvailable ? tariffGroups : [],
            totalCost: totalBillCost,
            billingUnavailable: !billingAvailable,
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
                'X-Billing-Status': billing.status,
                'X-Data-Age-Minutes': dataAgeMinutes,
                'X-SOC-Age-Minutes': socAgeHeader,
                'X-Component-Config': componentDebug
            }
        });

        return response;


        } catch (error) {
            logEvent('error', 'trmnl.markup.failed', { error });
            return NextResponse.json({ error: (error as Error).message }, { status: 500 });
        }
    });
}

async function handlePOST(request: Request) {
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

export const GET = observeRoute('/api/trmnl/markup', handleGET);

export const POST = observeRoute('/api/trmnl/markup', handlePOST);
