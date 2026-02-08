import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';


import { Importer } from '@/lib/importer';
import { TeslaClient, EnergySiteLiveStatus } from '@/lib/tesla-client';
import { verifySiteAccess } from '@/lib/auth-checks';
import QRCode from 'qrcode';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const uuid = searchParams.get('uuid');
        const siteIdParam = searchParams.get('site_id');

        let installation = null;
        let siteId = '';

        if (uuid) {
            const service = new TrmnlService();
            console.log(`[TrmnlMarkup] Lookup UUID: ${uuid}`);
            installation = await service.getInstallationByUuid(uuid);
            console.log(`[TrmnlMarkup] Found installation: ${installation ? installation.id : 'null'}`);

            if (!installation) {
                // New Installation / "Zombie" UUID flow
                // The UUID is not linked to any site yet. We return the QR code to allow the user to link it manually.
                const host = request.headers.get('host') || 'localhost:3000';
                const protocol = host.includes('localhost') ? 'http' : 'https';
                const manageUrl = `${protocol}://${host}/trmnl/manage?uuid=${uuid}`;

                console.log(`[TrmnlMarkup] UUID ${uuid} not found. Generating setup QR code for ${manageUrl}`);

                // Generate QR Code
                const qrDataUrl = await QRCode.toDataURL(manageUrl, { margin: 2, width: 300 });

                const markup = `
                    <div class="view view--full">
                         <div class="layout layout--col layout--center" style="padding: 20px; text-align: center;">
                            <span class="title title--small">Setup Required</span>
                            <img src="${qrDataUrl}" style="width: 150px; height: 150px; margin: 10px auto; display: block;" />
                            <span class="label">Scan to Configure</span>
                         </div>
                    </div>
                 `;

                return NextResponse.json({
                    markup: markup,
                    markup_half_vertical: markup,
                    markup_half_horizontal: markup,
                    markup_quadrant: markup
                });
            }

            // Verify Bearer Token for UUID access
            const authHeader = request.headers.get('Authorization');
            if (installation.access_token) {
                if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== installation.access_token) {
                    console.warn(`[TrmnlMarkup] Invalid/Missing Bearer token for UUID ${uuid}`);

                    // Show QR Code to re-link/auth
                    const host = request.headers.get('host') || 'localhost:3000';
                    const protocol = host.includes('localhost') ? 'http' : 'https';
                    const manageUrl = `${protocol}://${host}/trmnl/manage?uuid=${uuid}`;

                    // Generate QR Code
                    const qrDataUrl = await QRCode.toDataURL(manageUrl, { margin: 2, width: 300 });

                    const markup = `
                        <div class="view view--full">
                             <div class="layout layout--col layout--center" style="padding: 20px; text-align: center;">
                                <span class="title title--small">Plugin Auth Failed</span>
                                <img src="${qrDataUrl}" style="width: 150px; height: 150px; margin: 10px auto; display: block;" />
                                <span class="label">Scan to Re-link</span>
                             </div>
                        </div>
                     `;

                    // Return 200 with markup instead of 401 to display the error on the device
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
                            'Surrogate-Control': 'no-store',
                            'X-Debug-Deploy-Check': 'verified'
                        }
                    });
                }
            } else {
                console.warn(`[TrmnlMarkup] No access token stored for UUID ${uuid}. Skipping verification.`);
            }

            siteId = installation.site_id;

        } else if (siteIdParam) {
            // Preview Mode: Authenticate via Cookie/API check logic
            // Use verifySiteAccess helper for consistency
            const hasAccess = await verifySiteAccess(siteIdParam);

            if (!hasAccess) {
                return NextResponse.json({ error: 'Unauthorized preview' }, { status: 401 });
            }

            siteId = siteIdParam;
            console.log(`[TrmnlMarkup] Previewing for Site ID: ${siteId}`);

        } else {
            return NextResponse.json({ error: 'Missing uuid or site_id parameter' }, { status: 400 });
        }

        const repo = new EnergyRepo();
        const site = await repo.getSite(siteId);

        if (!site) {
            return NextResponse.json({ error: 'Site not found' }, { status: 404 });
        }

        // Calculate bill for current period
        const billingStartDay = site.billing_start_day || 1;

        const now = new Date();
        let start = new Date(now.getFullYear(), now.getMonth(), billingStartDay);
        // If today is before the start day, we are in the previous month's cycle
        if (now.getDate() < billingStartDay) {
            start = new Date(now.getFullYear(), now.getMonth() - 1, billingStartDay);
        }

        // End is now (to show current usage)
        const end = now;

        // Calculate Cycle End for Display (Start + 1 Month)
        const cycleEnd = new Date(start);
        cycleEnd.setMonth(cycleEnd.getMonth() + 1);

        // --- AUTH & CLIENT INIT ---
        let trmnlClient: TeslaClient | null = null;
        let clientError: string | null = null;

        if (site.refresh_token) {
            console.log(`[Trmnl] Found refresh token for site ${site.id}, initializing client...`);
            const useToken = site.access_token || 'expired';

            trmnlClient = new TeslaClient({
                accessToken: useToken,
                refreshToken: site.refresh_token,
                tokenRefreshHandler: repo.getLockedRefreshHandler(site.id),
                onTokenUpdate: async () => {
                    console.log(`[Trmnl] Token update callback triggered for site ${site.id}`);
                }
            });
        } else {
            console.log(`[Trmnl] No refresh token found for site ${site.id}`);
            clientError = 'No refresh token available';
        }

        // --- PARALLEL LIVE STATUS FETCH ---
        let liveStatusPromise: Promise<EnergySiteLiveStatus | undefined> = Promise.resolve(undefined);
        let fetchStatus = 'skipped';

        if (trmnlClient) {
            // Set a 8s timeout for live status
            fetchStatus = 'pending';
            const fetchOp = trmnlClient.getLiveStatus(site.id);
            const timeoutOp = new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error('Live Status Timeout')), 8000));

            liveStatusPromise = Promise.race([fetchOp, timeoutOp]).catch(e => {
                console.warn('[TrmnlMarkup] Live status fetch failed/timed out:', e);
                fetchStatus = (e instanceof Error) ? e.message : 'error';
                return undefined;
            }) as Promise<EnergySiteLiveStatus | undefined>;
        }

        // --- SYNC LOGIC (Blocking for integrity) ---
        if (trmnlClient) {
            try {
                const importer = new Importer(trmnlClient);

                // 1. Sync RECENT data (Last 24-48h)
                const yesterday = new Date(now);
                yesterday.setDate(yesterday.getDate() - 1);
                yesterday.setHours(0, 0, 0, 0);

                console.log(`[Trmnl] Syncing recent data for site ${site.id}...`);
                await importer.ensureDataForRange(site.id, yesterday, end, (msg) => console.log(`[Trmnl] ${msg}`));

                // 2. Sync HISTORICAL data (Background/Best Effort)
                if (start < yesterday) {
                    const historyEnd = new Date(yesterday.getTime() - 1000);
                    console.log(`[Trmnl] Syncing historical data...`);

                    const historySyncPromise = importer.ensureDataForRange(site.id, start, historyEnd, (msg) => console.log(`[Trmnl-History] ${msg}`));
                    const timeoutPromise = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Historical Sync Timeout')), 4000));

                    try {
                        await Promise.race([historySyncPromise, timeoutPromise]);
                    } catch (timeoutErr) {
                        console.warn(`[Trmnl] Historical sync timed out (Non-fatal)`);
                    }
                }
            } catch (err) {
                console.error(`[Trmnl] Sync failed:`, err);
                clientError = (err instanceof Error) ? err.message : String(err);
            }
        }

        // Handle Auth/Sync Errors with QR Code
        if (clientError) {
            // Broaden the check
            if (clientError.includes('401') || clientError.includes('refresh token') || clientError.includes('403') || clientError === 'No refresh token available') {
                const host = request.headers.get('host') || 'localhost:3000';
                const protocol = host.includes('localhost') ? 'http' : 'https';
                const manageUrl = installation
                    ? `${protocol}://${host}/trmnl/manage?uuid=${installation.uuid}`
                    : `${protocol}://${host}/site/${site.id}/settings`;

                const qrDataUrl = await QRCode.toDataURL(manageUrl, { margin: 2, width: 300 });

                const markup = `
                    <div class="view view--full">
                         <div class="layout layout--col layout--center" style="padding: 20px; text-align: center;">
                            <span class="title title--small">Tesla Auth Required</span>
                            <span class="label">Scan to Connect</span>
                            <img src="${qrDataUrl}" style="width: 150px; height: 150px; margin: 10px 0;" />
                            <span class="label label--small">${site.name}</span>
                         </div>
                    </div>
                 `;

                return NextResponse.json({
                    markup: markup,
                    markup_half_vertical: markup,
                    markup_half_horizontal: markup,
                    markup_quadrant: markup
                });
            }
        }

        const usageData = await repo.getUsageByTOU(site.id, start, end);

        // Group by tariff and then by TOU (Logic from BillSummary.tsx)
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

        usageData.forEach(u => {
            const tName = u.tariff.name || 'Unknown';
            let group = tariffGroups.get(tName);
            if (!group) {
                group = { tariffId: u.tariff.id, tariffName: tName, periods: [] };
                tariffGroups.set(tName, group);
            }

            let label = u.touName || 'Standard';
            // Format label: OFF_PEAK -> Off-Peak
            label = label.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(' ', '-');

            group.periods.push({
                touName: u.touName || 'Standard',
                label: label,
                home: u.homeUsage,
                grid: u.gridUsage,
                solar: u.solarProduction,
                battery: u.batteryChange,
                cost: u.cost || 0
            });
        });

        // Calculate total cost for the summary
        let totalBillCost = 0;
        usageData.forEach(u => totalBillCost += (u.cost || 0));

        const currency = '$'; // TODO: Settings
        const costStr = totalBillCost.toFixed(2);
        const isCredit = totalBillCost < 0;
        const displayCost = isCredit ? `+${currency}${Math.abs(totalBillCost).toFixed(2)}` : `${currency}${costStr}`;
        const costLabel = isCredit ? 'Total Credit' : 'Total Cost';

        // Check for active period (needed for highlighting current TOU)
        const schedule = new Schedule(site.tariffs, site.timezone);
        const currentPeriod = schedule.getTariffPeriod(new Date());
        const currentTouName = currentPeriod?.schedule.name;

        // Fetch Today's Totals (Grid/Solar) for the Status Bar
        let todayGrid = 0;
        let todaySolar = 0;
        try {
            // Determine "today" in site timezone
            const tz = site.timezone || 'UTC';
            // Use en-CA for ISO-like format (YYYY-MM-DD) which matches DB expectation
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });

            const hourlyData = await repo.getHourlyEnergyData(site.id, todayStr);
            hourlyData.forEach(h => {
                todayGrid += h.gridUsage; // Net Grid Usage
                todaySolar += h.solarProduction;
            });

        } catch (e) {
            console.error('[TrmnlMarkup] Failed to fetch today totals', e);
        }

        // Await Live Status (which started earlier)
        // Since we caught errors in the promise definition, this shouldn't throw.
        const liveStatus = await liveStatusPromise;
        let batterySoc: number | null = null;
        let batteryStatus: 'charging' | 'discharging' | 'idle' = 'idle';

        if (liveStatus) {
            if (typeof liveStatus.percentage_charged === 'number') {
                batterySoc = liveStatus.percentage_charged;
            }
            const power = liveStatus.battery_power || 0;
            if (power < -50) batteryStatus = 'charging';
            else if (power > 50) batteryStatus = 'discharging';
        }

        // Prepare Render Context
        const { TrmnlRenderer } = await import('@/lib/trmnl-renderer');

        const renderCtx = {
            siteName: site.name || 'Powerwall',
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
            todaySolar: todaySolar
        };

        const markupFull = TrmnlRenderer.renderFull(renderCtx);
        const markupHalfVertical = TrmnlRenderer.renderHalfVertical(renderCtx);
        const markupHalfHorizontal = TrmnlRenderer.renderHalfHorizontal(renderCtx);
        const markupQuadrant = TrmnlRenderer.renderQuadrant(renderCtx);

        return NextResponse.json({
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
                'X-Debug-Battery-SOC': batterySoc?.toString() ?? 'null'
            }
        });


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
