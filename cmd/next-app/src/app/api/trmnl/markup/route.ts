import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { SettingsRepo } from '@/lib/settings-repo';
import { Importer } from '@/lib/importer';
import { TeslaClient } from '@/lib/tesla-client';

export async function POST(request: Request) {
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
        const settingsRepo = new SettingsRepo();
        const billingStartDay = settingsRepo.getBillingStartDay();

        const now = new Date();
        let start = new Date(now.getFullYear(), now.getMonth(), billingStartDay);
        // If today is before the start day, we are in the previous month's cycle
        if (now.getDate() < billingStartDay) {
            start = new Date(now.getFullYear(), now.getMonth() - 1, billingStartDay);
        }

        // End is now (to show current usage)
        const end = now;

        // Ensure data is up to date
        // Use Tesla Token from settings for the Importer (not the TRMNL token)
        const teslaToken = settingsRepo.getAccessToken();
        if (teslaToken) {
            try {
                const client = new TeslaClient({ accessToken: teslaToken });
                const importer = new Importer(client);
                // Allow a generous timeout for background sync if needed? POST handlers in App Router have default timeouts.
                // We sync for the current billing period to ensure accuracy.
                await importer.ensureDataForRange(site.id, start, end);
            } catch (e) {
                console.error("Failed to sync data for TRMNL request", e);
                // Continue with existing data if sync fails
            }
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
