import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { Schedule } from '@/lib/schedule';
import { SettingsRepo } from '@/lib/settings-repo';

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
                                <th class="text--right">Bat</th>
                                <th class="text--right">Grid</th>
                                <th class="text--right">Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${periods.map(p => `
                                <tr>
                                    <td>${p.label}</td>
                                    <td class="text--right">${(p.home / 1000).toFixed(1)}</td>
                                    <td class="text--right">${(p.solar / 1000).toFixed(1)}</td>
                                    <td class="text--right">${(p.battery / 1000).toFixed(1)}</td>
                                    <td class="text--right">${(p.grid / 1000).toFixed(1)}</td>
                                    <td class="text--right">${currency}${p.cost.toFixed(2)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }).join('');

        // Trmnl Markup
        const markup = `
            <div class="view view--full">
                <div class="layout">
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
