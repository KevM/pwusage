
import { Tariff } from '@/lib/db';
import { formatTouName, formatTimeRange } from '@/lib/format-utils';

interface TariffListProps {
    tariffs: Tariff[];
}

export function TariffList({ tariffs }: TariffListProps) {
    if (!tariffs || tariffs.length === 0) {
        return (
            <div className="p-6 bg-gray-100 dark:bg-slate-800 rounded-lg">
                <p className="text-gray-500 dark:text-gray-400">No tariffs found for this site.</p>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {tariffs.map((tariff) => (
                <div key={tariff.id} className="border rounded-lg p-6 shadow-sm bg-gray-50 dark:bg-slate-800/50 dark:border-slate-700">
                    <h2 className="text-2xl font-semibold mb-4">{formatTouName(tariff.name || `Tariff #${tariff.id}`)}</h2>

                    {(!tariff.seasons || tariff.seasons.length === 0) ? (
                        <p className="text-gray-500 italic">No seasons defined.</p>
                    ) : (
                        <div className="space-y-6">
                            {tariff.seasons.map((season) => (
                                <div key={season.id} className="bg-white dark:bg-slate-900 p-4 rounded-md border dark:border-slate-800">
                                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                                        <h3 className="text-xl font-medium">{formatTouName(season.name || 'Unnamed Season')}</h3>
                                        <span className="text-sm text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-slate-700 px-2 py-1 rounded">
                                            {season.from_month}/{season.from_day} - {season.to_month}/{season.to_day}
                                        </span>
                                    </div>

                                    {(!season.schedules || season.schedules.length === 0) ? (
                                        <p className="text-gray-500 dark:text-gray-400 italic text-sm">No schedules defined.</p>
                                    ) : (
                                        <div className="overflow-x-auto">
                                            <table className="min-w-full text-sm">
                                                <thead>
                                                    <tr className="bg-gray-100 dark:bg-slate-800 text-left dark:text-gray-200">
                                                        <th className="p-2 rounded-l">Schedule Name</th>
                                                        <th className="p-2">Time Range</th>
                                                        <th className="p-2">Days</th>
                                                        <th className="p-2">Buy Rate ($/kWh)</th>
                                                        <th className="p-2 rounded-r">Sell Rate ($/kWh)</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {season.schedules.map((schedule) => (
                                                        <tr key={schedule.id} className="border-b last:border-0 dark:border-slate-700">
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
    );
}

function getDayName(day: number): string {
    // Tesla uses 0=Monday, 6=Sunday
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days[day] || String(day);
}
