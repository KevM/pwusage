import { EnergyRepo } from '@/lib/energy-repo';
import { SettingsRepo } from '@/lib/settings-repo';
import { formatTouName, formatTimeRange } from '@/lib/format-utils';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function TariffPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const repo = new EnergyRepo();
    const settingsRepo = new SettingsRepo();

    const token = settingsRepo.getAccessToken();
    if (!token) {
        return <div className="p-24 text-center">Not authenticated</div>;
    }

    const site = repo.getSite(id);
    if (!site) {
        notFound();
    }

    return (
        <div className="flex min-h-screen flex-col items-center p-24">
            <div className="w-full max-w-4xl">
                <Link href={`/site/${id}`} className="text-blue-600 hover:underline mb-4 block">&larr; Back to Site Details</Link>
                <h1 className="text-4xl font-bold mb-8">Tariffs for {site.name}</h1>

                {site.tariffs.length === 0 ? (
                    <div className="p-6 bg-gray-100 rounded-lg">
                        <p>No tariffs found for this site.</p>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {site.tariffs.map((tariff) => (
                            <div key={tariff.id} className="border rounded-lg p-6 shadow-sm bg-white">
                                <h2 className="text-2xl font-semibold mb-4">{formatTouName(tariff.name || `Tariff #${tariff.id}`)}</h2>

                                {(!tariff.seasons || tariff.seasons.length === 0) ? (
                                    <p className="text-gray-500 italic">No seasons defined.</p>
                                ) : (
                                    <div className="space-y-6">
                                        {tariff.seasons.map((season) => (
                                            <div key={season.id} className="bg-gray-50 p-4 rounded-md">
                                                <div className="flex justify-between items-center mb-3">
                                                    <h3 className="text-xl font-medium">{formatTouName(season.name || 'Unnamed Season')}</h3>
                                                    <span className="text-sm text-gray-600 bg-gray-200 px-2 py-1 rounded">
                                                        {season.from_month}/{season.from_day} - {season.to_month}/{season.to_day}
                                                    </span>
                                                </div>

                                                {(!season.schedules || season.schedules.length === 0) ? (
                                                    <p className="text-gray-500 italic text-sm">No schedules defined.</p>
                                                ) : (
                                                    <div className="overflow-x-auto">
                                                        <table className="min-w-full text-sm">
                                                            <thead>
                                                                <tr className="bg-gray-200 text-left">
                                                                    <th className="p-2 rounded-l">Schedule Name</th>
                                                                    <th className="p-2">Time Range</th>
                                                                    <th className="p-2">Days</th>
                                                                    <th className="p-2">Buy Rate ($/kWh)</th>
                                                                    <th className="p-2 rounded-r">Sell Rate ($/kWh)</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                {season.schedules.map((schedule) => (
                                                                    <tr key={schedule.id} className="border-b last:border-0">
                                                                        <td className="p-2 font-medium">{formatTouName(schedule.name || 'Standard')}</td>
                                                                        <td className="p-2">
                                                                            {formatTimeRange(
                                                                                schedule.from_hour,
                                                                                schedule.from_minute,
                                                                                schedule.to_hour,
                                                                                schedule.to_minute
                                                                            )}
                                                                        </td>
                                                                        <td className="p-2">
                                                                            {(schedule.from_day_of_week === 0 && schedule.to_day_of_week === 6) ? 'Every Day' : (
                                                                                schedule.from_day_of_week !== null ? (
                                                                                    `${getDayName(schedule.from_day_of_week)} - ${getDayName(schedule.to_day_of_week!)}`
                                                                                ) : 'Every Day'
                                                                            )}
                                                                        </td>
                                                                        <td className="p-2 text-red-600 font-mono">
                                                                            ${(schedule.buy_rate ?? season.buy_rate).toFixed(4)}
                                                                        </td>
                                                                        <td className="p-2 text-green-600 font-mono">
                                                                            ${(schedule.sell_rate ?? season.sell_rate).toFixed(4)}
                                                                        </td>
                                                                    </tr>
                                                                ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function getDayName(day: number): string {
    // Tesla uses 0=Monday, 6=Sunday
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days[day] || String(day);
}
