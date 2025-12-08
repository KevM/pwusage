import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';

import { Importer } from '@/lib/importer';
import { TeslaClient } from '@/lib/tesla-client';
import QRCode from 'qrcode';

export async function GET(request: Request) {
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 });
        }

        const accessToken = authHeader.split(' ')[1];
        const service = new TrmnlService();
        const installation = service.getInstallationByToken(accessToken);

        if (!installation) {
            return NextResponse.json({ error: 'Installation not found' }, { status: 404 });
        }

        const repo = new EnergyRepo();
        const site = repo.getSite(installation.site_id);
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

        // Use centralized Site tokens for sync
        if (site.refresh_token) {
            console.log(`[Trmnl] Found refresh token for site ${site.id}, attempting sync...`);

            const client = new TeslaClient({
                accessToken: site.access_token || 'expired',
                refreshToken: site.refresh_token,
                tokenRefreshHandler: repo.getLockedRefreshHandler(site.id),
                onTokenUpdate: async (newAccess, newRefresh) => {
                    console.log(`[Trmnl] Token update callback triggered for site ${site.id}`);
                }
            });

            // Sync recent data to ensure freshness
            try {
                const importer = new Importer(client);

                // Sync current month
                await importer.ensureDataForRange(site.id, start, end);
                console.log(`[Trmnl] Sync successful for site ${site.id}`);
            } catch (err: any) {
                console.error(`[Trmnl] Sync failed for site ${site.id}:`, err);

                // If auth error, show QR code to re-authenticate
                if (err.message.includes('401') || err.message.includes('refresh token')) {
                    const host = request.headers.get('host') || 'localhost:3000';
                    const protocol = host.includes('localhost') ? 'http' : 'https';
                    const manageUrl = `${protocol}://${host}/trmnl/manage?uuid=${installation.uuid}`;

                    // Generate QR Code
                    const qrDataUrl = await QRCode.toDataURL(manageUrl, { margin: 2, width: 300 });

                    const markup = `
                        <div class="view view--full">
                             <div class="layout layout--col-center" style="padding: 20px; text-align: center;">
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
            console.log(`[Trmnl] No refresh token found for site ${site.id} (in Site table), skipping sync.`);
        }

        const usageData = repo.getUsageByTOU(site.id, start, end);

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
        const costLabel = isCredit ? 'Est. Credit' : 'Est. Cost';

        // Check for active period
        const schedule = new Schedule(site.tariffs, site.timezone);
        const currentPeriod = schedule.getTariffPeriod(new Date());
        const currentTouName = currentPeriod?.schedule.name;

        // Generate HTML for each tariff group
        const tariffHtml = Array.from(tariffGroups.values()).map(group => {
            // Sort periods by name
            const periods = group.periods.sort((a, b) => a.touName.localeCompare(b.touName));

            return `
                <div class="mb-4">
                    <span class="label label--underline mb-2">${group.tariffName}</span>
                    <table class="table table--compact">
                        <thead>
                            <tr>
                                <th>Period</th>
                                <th class="text--right">Home</th>
                                <th class="text--right">Sol</th>
                                <th class="text--right">Batt</th>
                                <th class="text--right">Grid</th>
                                <th class="text--right">Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${periods.map(p => {
                const isCurrent = currentTouName && p.touName === currentTouName;
                const b = isCurrent ? '<b>' : '';
                const eb = isCurrent ? '</b>' : '';
                return `
                                <tr>
                                    <td>${b}${p.label}${eb}</td>
                                    <td class="text--right">${b}${(p.home / 1000).toFixed(1)}${eb}</td>
                                    <td class="text--right">${b}${(p.solar / 1000).toFixed(1)}${eb}</td>
                                    <td class="text--right">${b}${(p.battery / 1000).toFixed(1)}${eb}</td>
                                    <td class="text--right">${b}${(p.grid / 1000).toFixed(1)}${eb}</td>
                                    <td class="text--right">${b}${currency}${p.cost.toFixed(2)}${eb}</td>
                                </tr>
                            `}).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }).join('');

        // Trmnl Markup
        const markup = `
            <div class="view view--full">
                <div class="layout" style="padding: 2.5rem;">
                    <div class="columns">
                        <div class="column">
                            <div class="markdown gap--large">
                                <span class="title text--left">${site.name}</span>
                                <span class="label text--left mb-2">${start.toLocaleDateString()} - ${end.toLocaleDateString()}</span>
                                
                                ${tariffHtml}

                                <div class="content-element content content--center mt-4">
                                    <span class="label">${costLabel}</span>
                                    <span class="title title--large">${displayCost}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        return NextResponse.json({
            markup: markup,
            markup_half_vertical: markup, // TODO: Optimize for half view
            markup_half_horizontal: markup, // TODO: Optimize for half view
            markup_quadrant: markup // TODO: Optimize for quadrant view
        });

    } catch (error) {
        console.error('Markup error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}

export { GET as POST };
