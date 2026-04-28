
import { Tariff } from '@/lib/db';
import { formatTouName, formatTimeRange } from '@/lib/format-utils';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';

interface TariffListProps {
    tariffs: Tariff[];
}

export function TariffList({ tariffs }: TariffListProps) {
    if (!tariffs || tariffs.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Tariff Information</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-gray-500 dark:text-gray-400">No tariffs found for this site.</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-8">
            {tariffs.map((tariff) => (
                <Card key={tariff.id}>
                    <CardHeader>
                        <CardTitle>{formatTouName(tariff.name || `Tariff #${tariff.id}`)} Tariff Information</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {(!tariff.seasons || tariff.seasons.length === 0) ? (
                            <p className="text-gray-500 italic">No seasons defined.</p>
                        ) : (
                            <div className="space-y-6">
                                {tariff.seasons.map((season) => (
                                    <Card key={season.id} className="shadow-sm overflow-hidden border-gray-200 dark:border-slate-700">
                                        <CardHeader
                                            className="pb-3 bg-white dark:bg-slate-900 border-b border-gray-100 dark:border-slate-800"
                                            action={
                                                <div className="text-sm text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-slate-700 px-2 py-1 rounded">
                                                    {formatSeasonDate(season.from_month, season.from_day)} - {formatSeasonDate(season.to_month, season.to_day)}
                                                </div>
                                            }
                                        >
                                            <CardTitle className="text-xl font-medium">{formatTouName(season.name || 'Unnamed Season')}</CardTitle>
                                        </CardHeader>

                                        <CardContent className="p-0 bg-gray-50/50 dark:bg-slate-900/50">
                                            {(!season.schedules || season.schedules.length === 0) ? (
                                                <div className="p-6">
                                                    <p className="text-gray-500 dark:text-gray-400 italic text-sm">No schedules defined.</p>
                                                </div>
                                            ) : (
                                                <Table>
                                                    <TableHeader className="border-b border-gray-200 dark:border-slate-700">
                                                        <TableRow className="bg-gray-100 dark:bg-slate-800/80">
                                                            <TableHead className="pl-4 text-gray-700 dark:text-gray-300">Schedule Name</TableHead>
                                                            <TableHead className="text-gray-700 dark:text-gray-300">Time Range</TableHead>
                                                            <TableHead className="text-gray-700 dark:text-gray-300">Days</TableHead>
                                                            <TableHead className="text-gray-700 dark:text-gray-300">Buy Rate ($/kWh)</TableHead>
                                                            <TableHead className="pr-4 text-gray-700 dark:text-gray-300">Sell Rate ($/kWh)</TableHead>
                                                        </TableRow>
                                                    </TableHeader>
                                                    <TableBody className="divide-y divide-gray-100 dark:divide-slate-800">
                                                        {season.schedules.map((schedule) => {
                                                            // Tesla emits "Every Day" (0-6) for weekday periods and relies on a
                                                            // Sat-Sun all-day entry to override weekends. When that override exists,
                                                            // time-windowed "Every Day" schedules are effectively Mon-Fri only.
                                                            const hasWeekendAllDayOverride = season.schedules?.some(s =>
                                                                s.id !== schedule.id &&
                                                                s.from_day_of_week !== null &&
                                                                s.from_day_of_week >= 5 &&
                                                                s.from_hour === null && s.to_hour === null
                                                            );
                                                            const isEveryDayWithSpecificHours =
                                                                schedule.from_day_of_week === 0 &&
                                                                schedule.to_day_of_week === 6 &&
                                                                (schedule.from_hour !== null || schedule.to_hour !== null);

                                                            const daysLabel = isEveryDayWithSpecificHours && hasWeekendAllDayOverride
                                                                ? 'Mon - Fri'
                                                                : (schedule.from_day_of_week === 0 && schedule.to_day_of_week === 6)
                                                                ? 'Every Day'
                                                                : (schedule.from_day_of_week !== null
                                                                    ? `${getDayName(schedule.from_day_of_week)} - ${getDayName(schedule.to_day_of_week!)}`
                                                                    : 'Every Day');

                                                            return (
                                                                <TableRow key={schedule.id}>
                                                                    <TableCell className="pl-4 font-medium">{formatTouName(schedule.name || 'Standard')}</TableCell>
                                                                    <TableCell className="text-gray-700 dark:text-gray-300">
                                                                        {formatTimeRange(
                                                                            schedule.from_hour,
                                                                            schedule.from_minute,
                                                                            schedule.to_hour,
                                                                            schedule.to_minute
                                                                        )}
                                                                    </TableCell>
                                                                    <TableCell className="text-gray-700 dark:text-gray-300">
                                                                        {daysLabel}
                                                                    </TableCell>
                                                                    <TableCell className="text-red-600">
                                                                        ${(schedule.buy_rate ?? season.buy_rate).toFixed(4)}
                                                                    </TableCell>
                                                                    <TableCell className="pr-4 text-green-600">
                                                                        ${(schedule.sell_rate ?? season.sell_rate).toFixed(4)}
                                                                    </TableCell>
                                                                </TableRow>
                                                            );
                                                        })}
                                                    </TableBody>
                                                </Table>
                                            )}
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}

function getDayName(day: number): string {
    // Tesla uses 0=Monday, 6=Sunday
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days[day] || String(day);
}

function formatSeasonDate(month: number | null | undefined, day: number | null | undefined): string {
    if (!month || !day) return '';
    const date = new Date(2000, month - 1, day);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
