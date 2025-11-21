import { EnergyRepo } from '@/lib/energy-repo';
import Link from 'next/link';
import { EnergyChartWithNav } from '@/components/EnergyChartWithNav';
import { SiteLiveStats } from '@/components/SiteLiveStats';
import { SettingsRepo } from '@/lib/settings-repo';
import { TeslaClient } from '@/lib/tesla-client';
import { Schedule } from '@/lib/schedule';
import { Importer } from '@/lib/importer';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function SitePage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ date?: string }>;
}) {
    const { id } = await params;
    const { date: queryDate } = await searchParams;
    const repo = new EnergyRepo();
    const settingsRepo = new SettingsRepo();

    // Always ensure the site exists (idempotent) before rendering
    const cookieStore = await cookies();
    let token = cookieStore.get('access_token')?.value;
    if (!token) {
        // Fall back to saved token in AppSettings (used by worker)
        token = settingsRepo.getAccessToken();
    }
    if (!token) {
        return <div>Not authenticated</div>;
    }

    const importer = new Importer(token);
    await importer.ensureSite(id);

    const site = repo.getSite(id);
    if (!site) {
        return <div>Site not found</div>;
    }

    // Get live stats for initial render
    let initialStats = {
        solarPower: 0,
        loadPower: 0,
        batteryPower: 0,
        gridPower: 0,
        percentageCharged: 0,
        currentTariff: 'Unknown'
    };

    if (token) {
        try {
            const client = new TeslaClient(token);
            const liveStatus = await client.getLiveStatus(id);

            // Get current tariff
            let currentTariff = 'Unknown';
            if (site.tariffs.length > 0) {
                const schedule = new Schedule(site.tariffs);
                const tariffPeriod = schedule.getTariffPeriod(new Date());
                if (tariffPeriod) {
                    const season = tariffPeriod.season.name || 'Season';
                    const tariffName = tariffPeriod.tariff.name || 'Unknown';
                    currentTariff = `${season} - ${tariffName}`;
                }
            }

            initialStats = {
                solarPower: liveStatus.solar_power,
                loadPower: liveStatus.load_power,
                batteryPower: liveStatus.battery_power,
                gridPower: liveStatus.grid_power,
                percentageCharged: liveStatus.percentage_charged,
                currentTariff
            };
        } catch (error) {
            console.error('Failed to fetch initial live stats:', error);
        }
    }

    // Get hourly data for the requested date (from query param) or today
    const now = new Date();
    let dateStr: string;

    if (queryDate) {
        dateStr = queryDate;
    } else {
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        dateStr = `${year}-${month}-${day}`;
    }

    const hourlyData = repo.getHourlyEnergyData(id, dateStr, site.timezone);

    // Calculate period based on billing start day
    const billingDay = settingsRepo.getBillingStartDay();
    let startMonth = now.getMonth();
    let startYear = now.getFullYear();

    // If today is before the billing day, we are in the previous month's billing cycle
    if (now.getDate() < billingDay) {
        startMonth--;
    }

    const start = new Date(startYear, startMonth, billingDay);
    // End date is start date + 1 month
    const end = new Date(start.getFullYear(), start.getMonth() + 1, billingDay);

    const usage = repo.getUsageByTOU(id, start, end);

    // Group by tariff and then by TOU
    const tariffGroups = new Map<string, {
        tariffName: string;
        periods: {
            touName: string;
            home: number;
            grid: number;
            solar: number;
            battery: number;
            cost: number;
        }[];
    }>();

    usage.forEach(u => {
        const tName = u.tariff.name || 'Unknown';
        let group = tariffGroups.get(tName);
        if (!group) {
            group = { tariffName: tName, periods: [] };
            tariffGroups.set(tName, group);
        }
        group.periods.push({
            touName: u.touName || 'Standard',
            home: u.homeUsage,
            grid: u.gridUsage,
            solar: u.solarProduction,
            battery: u.batteryChange,
            cost: u.cost || 0
        });
    });

    return (
        <div className="flex min-h-screen flex-col items-center p-24">
            <div className="w-full max-w-6xl">
                <Link href="/" className="text-blue-600 hover:underline mb-4 block">&larr; Back to Dashboard</Link>
                <h1 className="text-4xl font-bold mb-4">{site.name}</h1>

                {/* Live Stats */}
                <SiteLiveStats siteId={id} initialStats={initialStats} />

                {/* Hourly Chart with Navigation */}
                <div className="mb-8">
                    <EnergyChartWithNav
                        initialData={{ date: dateStr, data: hourlyData }}
                        siteId={id}
                    />
                </div>

                <h2 className="text-2xl font-bold mb-4">Usage for {start.toLocaleDateString()} - {end.toLocaleDateString()}</h2>

                <div className="grid gap-6">
                    {Array.from(tariffGroups.values()).map((t) => (
                        <div key={t.tariffName} className="border p-6 rounded shadow bg-white dark:bg-slate-900">
                            <h3 className="text-xl font-semibold mb-4">{t.tariffName}</h3>
                            <div className="space-y-6">
                                {t.periods.sort((a, b) => a.touName.localeCompare(b.touName)).map((p) => (
                                    <div key={p.touName} className="border-t pt-4 first:border-t-0 first:pt-0">
                                        <div className="flex justify-between items-center mb-2">
                                            <h4 className="font-medium text-lg">{p.touName}</h4>
                                            <div className="text-right">
                                                <span className={`font-bold ${p.cost >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                                                    {p.cost >= 0 ? '$' : '-$'}
                                                    {Math.abs(p.cost).toFixed(2)}
                                                </span>
                                                <span className="text-xs text-gray-500 block">Est. Cost</span>
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                            <div>
                                                <p className="text-sm text-gray-500">Home Usage</p>
                                                <p className="text-lg font-medium text-blue-700">{(p.home / 1000).toFixed(2)} kWh</p>
                                            </div>
                                            <div>
                                                <p className="text-sm text-gray-500">Solar Production</p>
                                                <p className="text-lg font-medium text-amber-700">{(p.solar / 1000).toFixed(2)} kWh</p>
                                            </div>
                                            <div>
                                                <p className="text-sm text-gray-500">Grid Usage</p>
                                                <p className="text-lg font-medium text-orange-700">{(p.grid / 1000).toFixed(2)} kWh</p>
                                            </div>
                                            <div>
                                                <p className="text-sm text-gray-500">Battery Change</p>
                                                <p className="text-lg font-medium text-purple-700">{(p.battery / 1000).toFixed(2)} kWh</p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
