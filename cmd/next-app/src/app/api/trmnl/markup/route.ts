import { NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';


import { Importer } from '@/lib/importer';
import { TeslaClient, EnergySiteLiveStatus } from '@/lib/tesla-client';
import { verifySiteAccess } from '@/lib/auth-checks';
import QRCode from 'qrcode';
import { TrmnlRenderer } from '@/lib/trmnl-renderer';
import { wattsToKilowatts } from '@/lib/energy-utils';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const routeStart = Date.now();
    try {
        const { searchParams } = new URL(request.url);
        const uuid = searchParams.get('uuid');
        const siteIdParam = searchParams.get('site_id');

        let installation: import('@/lib/db').TrmnlInstallation | null = null;
        let site: import('@/lib/db').SiteWithTariffs | null = null;
        const repo = new EnergyRepo();

        if (uuid) {
            const result = await repo.getInstallationAndSite(uuid);
            if (!result) {
                console.log(`[TrmnlMarkup] UUID ${uuid} not found. Generating setup QR code.`);
                return getQrResponse(request, uuid, 'Setup Required', 'Scan to Configure');
            }

            installation = result.installation;
            site = result.site;

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

        // --- 4-WAY PARALLEL DATA FETCHING ---

        const midnightToday = EnergyRepo.getSiteMidnight(now, site.timezone);
        let fetchStatus = 'skipped';

        const dbLatestPromise = (async () => {
            const start = Date.now();
            const res = await repo.getLatestEnergyData(site!.id);
            console.log(`[TrmnlMarkup] DB Latest Energy Lookup: ${Date.now() - start}ms`);
            return res;
        })();

        const dbHistoryPromise = (async () => {
            const startStr = Date.now();
            const res = await repo.getRawEnergyData(site!.id, start, midnightToday);
            console.log(`[TrmnlMarkup] DB Historical Fetch: ${Date.now() - startStr}ms`);
            return res;
        })();

        let teslaTodayPromise: Promise<import('@/lib/importer').EnergyDataRow[]> = Promise.resolve([]);
        let teslaLivePromise: Promise<EnergySiteLiveStatus | undefined> = Promise.resolve(undefined);

        if (trmnlClient) {
            const importer = new Importer(trmnlClient);
            const siteId = site.id;
            fetchStatus = 'pending';

            teslaTodayPromise = (async () => {
                const startStr = Date.now();
                const res = await importer.getTodayData(siteId);
                console.log(`[TrmnlMarkup] Tesla Today Usage Fetch: ${Date.now() - startStr}ms`);
                return res;
            })();

            teslaLivePromise = (async () => {
                const startStr = Date.now();
                const res = await trmnlClient!.getLiveStatus(siteId);
                console.log(`[TrmnlMarkup] Tesla Live Status Fetch: ${Date.now() - startStr}ms`);
                return res;
            })();
        }

        const combinedTimeout = 2000;
        let timeoutId: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<'timeout'>(resolve => {
            timeoutId = setTimeout(() => resolve('timeout'), combinedTimeout);
        });

        const parallelRace = await Promise.race([
            Promise.allSettled([dbLatestPromise, dbHistoryPromise, teslaTodayPromise, teslaLivePromise]),
            timeoutPromise
        ]);

        let latestTimestamp: Date | null = null;
        let historicalDbData: import('@/lib/db').EnergyData[] = [];
        let freshRows: import('@/lib/importer').EnergyDataRow[] = [];
        let liveStatus: EnergySiteLiveStatus | undefined = undefined;

        if (parallelRace === 'timeout') {
            console.warn(`[TrmnlMarkup] Parallel fetches reached timeout: ${combinedTimeout}ms`);
            // We might want to await them anyway here if they are critical, or fallback to empty
            // For now, let's treat timeout as a failure for the parallel block.
        } else {
            if (timeoutId) clearTimeout(timeoutId);
            const [latestRes, historyRes, todayRes, liveRes] = parallelRace;

            if (latestRes.status === 'fulfilled') latestTimestamp = latestRes.value?.timestamp ?? null;
            if (historyRes.status === 'fulfilled') historicalDbData = historyRes.value;

            if (todayRes.status === 'fulfilled') {
                freshRows = todayRes.value;
            } else {
                console.warn(`[TrmnlMarkup] Tesla Today Today fetch failed:`, todayRes.reason);
                if ((todayRes.reason?.message || '').includes('401') || (todayRes.reason?.message || '').includes('login_required')) {
                    return getQrResponse(request, uuid!, 'Tesla Auth Expired', 'Scan to Re-authenticate');
                }
            }

            if (liveRes.status === 'fulfilled' && liveRes.value) {
                liveStatus = liveRes.value;
                fetchStatus = 'success';
            }
        }

        // Prepare surgical update
        const missingRows = freshRows.filter(row => !latestTimestamp || row.timestamp.getTime() > latestTimestamp.getTime());

        const todayData = freshRows;

        // Fallback: ONLY if Tesla todayData fetch failed AND we have NO historical overlap? 
        // Actually, user said remove fallbacks. If Tesla is down, we show what we have.
        // We already joined historical data.

        // --- MERGE DATA ---
        // Combine historical DB data with today's data (Tesla or DB fallback)
        const allCycleData = [
            ...historicalDbData,
            ...todayData.map(row => ({
                ...row,
                id: 0,
            } as import('@/lib/db').EnergyData))
        ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        // --- IN-MEMORY AGGREGATION (TOU Stats & Chart Extraction) ---

        // Determine "today" in site timezone for chart extraction (Wall-Clock aligned)
        const tz = site.timezone || 'UTC';
        const fmtToday = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
        const partsToday = fmtToday.formatToParts(new Date());
        const getT = (type: string) => partsToday.find(p => p.type === type)?.value || '';

        const todayYear = getT('year');
        const todayMonth = getT('month');
        const todayDay = getT('day');

        const schedule = new Schedule(site.tariffs, site.timezone);
        const tariffMap = new Map<number, import('@/lib/db').Tariff>();
        site.tariffs.forEach(t => tariffMap.set(t.id, t));

        const aggregation = new Map<string, {
            tariff: import('@/lib/db').Tariff;
            touName: string;
            homeUsage: number;
            gridUsage: number;
            solarProduction: number;
            batteryChange: number;
            cost: number;
        }>();

        const seriesData: import('@/lib/db').EnergyData[] = [];
        let todayGrid = 0;
        let todaySolar = 0;

        // Site-local Formatting for TOU aggregation
        const fmtLocal = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });

        for (const row of allCycleData) {
            const ts = row.timestamp;
            const parts = fmtLocal.formatToParts(ts);
            const getL = (type: string) => parts.find(p => p.type === type)?.value || '';

            const tp = schedule.getTariffPeriod(ts);
            const yearStr = getL('year');
            const monthStr = getL('month');
            const dayStr = getL('day');

            // Extract today's points for the chart (Compare Site Time components)
            if (yearStr === todayYear && monthStr === todayMonth && dayStr === todayDay) {
                seriesData.push(row);
                todayGrid += row.grid_power;
                todaySolar += row.solar_power;
            }


            let touName = 'Unknown';
            let tariffName = 'Unknown';
            let buyRate = 0;
            let sellRate = 0;
            let currentTariff = site.tariffs[0];

            if (tp) {
                touName = tp.schedule.name || 'Standard';
                tariffName = tp.tariff.name || 'Unknown';
                buyRate = tp.schedule.buy_rate || 0;
                sellRate = tp.schedule.sell_rate || 0;
                currentTariff = tp.tariff;
            } else {
                const t = tariffMap.get(row.tariff_id);
                if (t) {
                    tariffName = t.name || 'Unknown';
                    currentTariff = t;
                }
            }

            const key = `${tariffName}|${touName}|${buyRate}|${sellRate}`;
            let data = aggregation.get(key);
            if (!data) {
                data = {
                    tariff: currentTariff,
                    touName: touName,
                    homeUsage: 0,
                    gridUsage: 0,
                    solarProduction: 0,
                    batteryChange: 0,
                    cost: 0
                };
                aggregation.set(key, data);
            }

            data.homeUsage += row.load_power;
            data.gridUsage += row.grid_power;
            data.solarProduction += row.solar_power;
            data.batteryChange += row.battery_power;

            // Calculate cost for this 5-min block incrementally
            const gridKwh = wattsToKilowatts(row.grid_power);
            if (gridKwh >= 0) {
                data.cost += gridKwh * buyRate;
            } else {
                data.cost += gridKwh * sellRate;
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

        for (const [key, data] of aggregation) {
            const [tariffName, touName] = key.split('|');
            let group = tariffGroups.get(tariffName);
            if (!group) {
                group = { tariffId: data.tariff.id, tariffName: tariffName, periods: [] };
                tariffGroups.set(tariffName, group);
            }

            let label = touName || 'Standard';
            label = label.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(' ', '-');

            group.periods.push({
                touName: touName,
                label: label,
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
        if (latestLiveStatus) {
            if (typeof latestLiveStatus.percentage_charged === 'number') {
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
            seriesData: seriesData
        };

        const layoutStart = Date.now();
        const markupFull = TrmnlRenderer.renderFull(renderCtx);
        const markupHalfVertical = TrmnlRenderer.renderHalfVertical(renderCtx);
        const markupHalfHorizontal = TrmnlRenderer.renderHalfHorizontal(renderCtx);
        const markupQuadrant = TrmnlRenderer.renderQuadrant(renderCtx);
        console.log(`[TrmnlMarkup] Rendering Logic: ${Date.now() - layoutStart}ms`);

        console.log(`[TrmnlMarkup] Total Route Logic: ${Date.now() - routeStart}ms`);

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
                'X-Debug-Live-Status': fetchStatus,
                'X-Debug-Battery-SOC': batterySoc !== null ? String(batterySoc) : 'null'
            }
        });

        // Step 6: Eventually the batch update completes.
        if (trmnlClient && missingRows.length > 0) {
            const importer = new Importer(trmnlClient);
            // Non-blocking persistence
            importer.persistHistory(site.id, missingRows, latestTimestamp).catch(e => {
                console.error(`[TrmnlMarkup] Background batch update failed:`, e);
            });
        }

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
