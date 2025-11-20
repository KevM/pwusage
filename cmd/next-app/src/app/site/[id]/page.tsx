import { EnergyRepo } from '@/lib/energy-repo';
import Link from 'next/link';
import { EnergyChartWithNav } from '@/components/EnergyChartWithNav';
import { SiteLiveStats } from '@/components/SiteLiveStats';
import { SettingsRepo } from '@/lib/settings-repo';
import { TeslaClient } from '@/lib/tesla-client';
import { Schedule } from '@/lib/schedule';
import { cookies } from 'next/headers';

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const repo = new EnergyRepo();
    const settingsRepo = new SettingsRepo();
    const site = repo.getSite(id);

    if (!site) {
        return <div>Site not found</div>;
    }

    // Get live stats for initial render
    const cookieStore = await cookies();
    const token = cookieStore.get('access_token')?.value;
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

    // Get today's hourly data
    const today = new Date();
    const hourlyData = repo.getHourlyEnergyData(id, today);
    // Use local date components instead of UTC
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;

    // Calculate period based on billing start day
    const billingDay = settingsRepo.getBillingStartDay();
    const now = new Date();
    let startMonth = now.getMonth();
    let startYear = now.getFullYear();

    // If today is before the billing day, we are in the previous month's billing cycle
    if (now.getDate() < billingDay) {
        startMonth--;
    }

    const start = new Date(startYear, startMonth, billingDay);
    // End date is start date + 1 month
    const end = new Date(start.getFullYear(), start.getMonth() + 1, billingDay);

    const usage = repo.getEnergyUsage(id, start, end);

    // Group by tariff
    const tariffUsage = new Map<string, {
        tariffName: string;
        home: number;
        grid: number;
        solar: number;
        battery: number;
    }>();

    usage.forEach(u => {
        const name = u.tariff.name || 'Unknown';
        const existing = tariffUsage.get(name) || {
            tariffName: name,
            home: 0,
            grid: 0,
            solar: 0,
            battery: 0,
        };

        existing.home += u.homeUsage;
        existing.grid += u.gridUsage;
        existing.solar += u.solarProduction;
        existing.battery += u.batteryChange;
        tariffUsage.set(name, existing);
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
                        initialData={{ date: todayStr, data: hourlyData }}
                        siteId={id}
                    />
                </div>

                <h2 className="text-2xl font-bold mb-4">Usage for {start.toLocaleDateString()} - {end.toLocaleDateString()}</h2>

                <div className="grid gap-6">
                    {Array.from(tariffUsage.values()).map((t) => (
                        <div key={t.tariffName} className="border p-6 rounded shadow">
                            <h3 className="text-xl font-semibold mb-4">{t.tariffName}</h3>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <div>
                                    <p className="text-sm text-gray-500">Home Usage</p>
                                    <p className="text-lg font-medium text-blue-700">{(t.home / 1000).toFixed(2)} kWh</p>
                                </div>
                                <div>
                                    <p className="text-sm text-gray-500">Solar Production</p>
                                    <p className="text-lg font-medium text-amber-700">{(t.solar / 1000).toFixed(2)} kWh</p>
                                </div>
                                <div>
                                    <p className="text-sm text-gray-500">Grid Usage</p>
                                    <p className="text-lg font-medium text-orange-700">{(t.grid / 1000).toFixed(2)} kWh</p>
                                </div>
                                <div>
                                    <p className="text-sm text-gray-500">Battery Change</p>
                                    <p className="text-lg font-medium text-purple-700">{(t.battery / 1000).toFixed(2)} kWh</p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
