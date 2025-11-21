import { EnergyRepo } from '@/lib/energy-repo';
import Link from 'next/link';
import { EnergyChartWithNav } from '@/components/EnergyChartWithNav';
import { SiteLiveStats } from '@/components/SiteLiveStats';
import { BillSummary } from '@/components/BillSummary';
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

    const token = settingsRepo.getAccessToken();
    const refreshToken = settingsRepo.getRefreshToken();

    if (!token) {
        return <div>Not authenticated</div>;
    }

    const client = new TeslaClient({
        accessToken: token,
        refreshToken: refreshToken,
        onTokenUpdate: (newAccess, newRefresh) => {
            console.log('Refreshing tokens in DB from Site Page');
            settingsRepo.setAccessToken(newAccess);
            settingsRepo.setRefreshToken(newRefresh);
        }
    });

    const importer = new Importer(client);
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

    // Determine reference date: queryDate or now
    let refDate = now;
    if (queryDate) {
        const [y, m, d] = queryDate.split('-').map(Number);
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
            refDate = new Date(y, m - 1, d);
        }
    }

    let startMonth = refDate.getMonth();
    let startYear = refDate.getFullYear();

    // If reference date is before the billing day, we are in the previous month's billing cycle
    if (refDate.getDate() < billingDay) {
        startMonth--;
    }

    const start = new Date(startYear, startMonth, billingDay);
    // End date is start date + 1 month
    const end = new Date(start.getFullYear(), start.getMonth() + 1, billingDay);

    const usage = repo.getUsageByTOU(id, start, end);

    // Determine active tariff ID
    let activeTariffId: number | undefined;
    if (site.tariffs.length > 0) {
        const schedule = new Schedule(site.tariffs);
        const tariffPeriod = schedule.getTariffPeriod(new Date());
        if (tariffPeriod) {
            activeTariffId = tariffPeriod.tariff.id;
        }
    }

    // Navigation dates
    const prevDate = new Date(start.getFullYear(), start.getMonth() - 1, billingDay);
    const nextDate = new Date(start.getFullYear(), start.getMonth() + 1, billingDay);
    const fmtDate = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    // Check if next month would be in the future
    const currentDate = new Date();
    const isCurrentPeriod = currentDate >= start && currentDate < end;

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

                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-2xl font-bold">Usage for {start.toLocaleDateString()} - {end.toLocaleDateString()}</h2>
                    <div className="flex items-center gap-4">
                        <Link
                            href={`/site/${id}/usage?date=${fmtDate(prevDate)}`}
                            className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                        >
                            ← Prev Month
                        </Link>
                        {isCurrentPeriod ? (
                            <span className="px-3 py-1 bg-gray-300 text-gray-500 rounded cursor-not-allowed">
                                Next Month →
                            </span>
                        ) : (
                            <Link
                                href={`/site/${id}/usage?date=${fmtDate(nextDate)}`}
                                className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                            >
                                Next Month →
                            </Link>
                        )}
                        <span className="text-gray-300">|</span>
                        <Link
                            href={`/site/${id}/usage?date=${fmtDate(start)}`}
                            className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium"
                        >
                            View Full Bill →
                        </Link>
                        <Link
                            href={`/site/${id}/tariffs`}
                            className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700 font-medium"
                        >
                            View Tariffs →
                        </Link>
                    </div>
                </div>

                <BillSummary usage={usage} activeTariffId={activeTariffId} />
            </div>
        </div>
    );
}
