import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { cookies } from 'next/headers';

import { Importer } from '@/lib/importer';
import { TeslaClient, EnergySiteLiveStatus } from '@/lib/tesla-client';
import { verifySiteToken } from '@/lib/auth-jwt';
import QRCode from 'qrcode';

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
                    });
                }
            } else {
                console.warn(`[TrmnlMarkup] No access token stored for UUID ${uuid}. Skipping verification.`);
            }

            siteId = installation.site_id;

        } else if (siteIdParam) {
            // Preview Mode: Authenticate via Session Cookies
            const cookieStore = await cookies();
            const siteAuth = cookieStore.get('site_auth')?.value;

            let hasAccess = false;

            // Check site_auth first (local verification, fastest)
            if (siteAuth) {
                const authorizedSites = verifySiteToken(siteAuth);
                if (authorizedSites && authorizedSites.includes(siteIdParam)) {
                    hasAccess = true;
                    console.log(`[TrmnlMarkup] Authorized via site_auth cookie for site ${siteIdParam}`);
                }
            }

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

        if (site.refresh_token) {
            console.log(`[Trmnl] Found refresh token for site ${site.id}, attempting sync...`);

            const useToken = site.access_token || 'expired'; // Trigger refresh if null

            console.log('[TrmnlMarkup] Using Stored Site Token for sync');

            const client = new TeslaClient({
                accessToken: useToken,
                refreshToken: site.refresh_token,
                tokenRefreshHandler: repo.getLockedRefreshHandler(site.id),
                onTokenUpdate: async () => {
                    console.log(`[Trmnl] Token update callback triggered for site ${site.id}`);
                }
            });

            // Sync recent data to ensure freshness
            try {
                const importer = new Importer(client);

                // 1. Sync RECENT data (Yesterday to Now) - Priority: HIGH
                // We ensure the last 48 hours are fresh so the display shows correct "Today" numbers and Battery status.
                const yesterday = new Date(now);
                yesterday.setDate(yesterday.getDate() - 1);
                yesterday.setHours(0, 0, 0, 0); // Start of yesterday

                console.log(`[Trmnl] Syncing recent data (Priority) for site ${site.id} from ${yesterday.toISOString()}...`);
                await importer.ensureDataForRange(site.id, yesterday, end, (msg) => console.log(`[Trmnl] ${msg}`));


                // 2. Sync HISTORICAL data (Start of Bill to Yesterday) - Priority: LOW (Background)
                // If there's a huge gap, this might take too long and cause Vercel 504.
                // We wrap this in a strict timeout. If it fails, we log it but continue rendering so the user sees *something*
                // rather than a timeout error.
                if (start < yesterday) {
                    const historyEnd = new Date(yesterday.getTime() - 1000); // Up to yesterday
                    console.log(`[Trmnl] Attempting background sync for historical data: ${start.toISOString()} to ${historyEnd.toISOString()}...`);

                    const historySyncPromise = importer.ensureDataForRange(site.id, start, historyEnd, (msg) => console.log(`[Trmnl-History] ${msg}`));

                    // 4-second strict timeout for history (Vercel max is usually 10s, we leave buffer for rendering)
                    const timeoutPromise = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Historical Sync Timeout')), 4000));

                    try {
                        await Promise.race([historySyncPromise, timeoutPromise]);
                        console.log(`[Trmnl] Historical sync completed.`);
                    } catch (timeoutErr) {
                        console.warn(`[Trmnl] Historical sync timed out or failed (Non-fatal):`, timeoutErr);
                        // Intentional: Swallowing error to ensure markup renders. 
                        // The totals might be off if data is missing, but display will work.
                    }
                }

                console.log(`[Trmnl] Sync check complete for site ${site.id}`);
            } catch (err) {
                console.error(`[Trmnl] Critical Sync failed for site ${site.id}:`, err);
                // Log the token context
                console.error(`[Trmnl] Token context - Access available: ${!!useToken}, Refresh available: ${!!site.refresh_token}`);

                // If auth error, show QR code to re-authenticate
                const errorMsg = (err instanceof Error) ? err.message : String(err);
                // Broaden the check: 401, 403, refresh token, or just "Tesla API Error" usually implies we need re-auth if manual retry failed.
                if (errorMsg.includes('401') || errorMsg.includes('refresh token') || errorMsg.includes('403')) {
                    const host = request.headers.get('host') || 'localhost:3000';
                    const protocol = host.includes('localhost') ? 'http' : 'https';
                    const manageUrl = installation
                        ? `${protocol}://${host}/trmnl/manage?uuid=${installation.uuid}`
                        : `${protocol}://${host}/site/${site.id}/settings`;

                    // Generate QR Code
                    const qrDataUrl = await QRCode.toDataURL(manageUrl, { margin: 2, width: 300 });

                    const markup = `
                        <div class="view view--full">
                             <div class="layout layout--col layout--center" style="padding: 20px; text-align: center;">
                                <span class="title title--small">Tesla Auth Expired</span>
                                <span class="label">Scan to Re-connect</span>
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
        } else {
            console.log(`[Trmnl] No refresh token found for site ${site.id}, showing Auth QR code.`);

            // If we don't have a refresh token, we MUST prompt for auth, otherwise data will be stale forever.
            const host = request.headers.get('host') || 'localhost:3000';
            const protocol = host.includes('localhost') ? 'http' : 'https';
            const manageUrl = installation
                ? `${protocol}://${host}/trmnl/manage?uuid=${installation.uuid}`
                : `${protocol}://${host}/site/${site.id}/settings`;

            // Generate QR Code
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

        // Check for active period
        const schedule = new Schedule(site.tariffs, site.timezone);
        const currentPeriod = schedule.getTariffPeriod(new Date());
        const currentTouName = currentPeriod?.schedule.name;

        // Generate HTML for each tariff group
        // Fetch latest SOC (Live from API)
        let batterySoc: number | null = null;
        let batteryStatus: 'charging' | 'discharging' | 'idle' = 'idle';
        try {
            // Re-use logic to get a client with refresh capabilities
            const useToken = site.access_token;
            // Removed: Preview mode using 'access_token' cookie. Now relies on site.access_token.

            if (useToken) {
                const client = new TeslaClient({
                    accessToken: useToken,
                    refreshToken: site.refresh_token,
                    tokenRefreshHandler: repo.getLockedRefreshHandler(site.id)
                });

                // Set a short timeout for live status to avoid hanging the render too long
                const liveStatusPromise = client.getLiveStatus(site.id);
                const timeoutPromise = new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000));

                try {
                    const liveStatus = await Promise.race([liveStatusPromise, timeoutPromise]) as EnergySiteLiveStatus;
                    if (liveStatus) {
                        if (typeof liveStatus.percentage_charged === 'number') {
                            batterySoc = liveStatus.percentage_charged;
                        }

                        const power = liveStatus.battery_power || 0;
                        // battery_power: Positive = Discharging, Negative = Charging
                        if (power < -50) {
                            batteryStatus = 'charging';
                        } else if (power > 50) {
                            batteryStatus = 'discharging';
                        }
                    }
                } catch (timeoutErr) {
                    console.warn('[TrmnlMarkup] Live status fetch timed out or failed', timeoutErr);
                }
            }
        } catch (e) {
            console.error('[TrmnlMarkup] Failed to fetch live SOC', e);
        }

        // Fetch Today's Totals (Grid/Solar) for the Status Bar
        let todayGrid = 0;
        let todaySolar = 0;
        try {
            // Determine "today" in site timezone
            // helper: formatDateWithTimezone is in tesla-client but not exported? 
            // We can use Intl.DateTimeFormat
            const tz = site.timezone || 'UTC';
            const nowInTz = new Date(); // Use a new Date object for timezone formatting
            const yyyy = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(nowInTz);
            const mm = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit' }).format(nowInTz);
            const dd = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: '2-digit' }).format(nowInTz);
            const todayStr = `${yyyy}-${mm}-${dd}`;

            const hourlyData = await repo.getHourlyEnergyData(site.id, todayStr);
            hourlyData.forEach(h => {
                todayGrid += h.gridUsage; // Imported - Exported? Hourly buckets might be net? 
                // Wait, getHourlyEnergyData buckets are sums of raw columns.
                // gridUsage in repo is row.grid_power. 
                // In importer, grid_power is net (Import - Export).
                // So positive gridUsage is NET grid usage. 
                // The user asked for "Grid and Solar Kwh usage". 
                // Usually "Grid Usage" means Net Grid Use (Imported - Exported) or just Import?
                // Let's assume Net Grid Usage (what we pay for) and Solar Production.

                todaySolar += h.solarProduction;
            });

        } catch (e) {
            console.error('[TrmnlMarkup] Failed to fetch today totals', e);
        }


        // Prepare Render Context
        const { TrmnlRenderer } = await import('@/lib/trmnl-renderer');

        const renderCtx = {
            siteName: site.name || 'Powerwall', // Retain 'Powerwall' fallback for robustness
            dateRange: `${start.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })} - ${cycleEnd.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}`,
            tariffGroups: Array.from(tariffGroups.values()), // Retain Array.from for consistency
            totalCost: totalBillCost,
            costLabel: costLabel, // Use existing 'costLabel'
            displayCost: displayCost, // Use existing 'displayCost'
            currency: currency, // Use existing 'currency'
            currentTouName: currentTouName || undefined, // Retain '|| undefined' for consistency
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
