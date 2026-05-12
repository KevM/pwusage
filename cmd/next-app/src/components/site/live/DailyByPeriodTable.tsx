import { formatTouName } from '@/lib/format-utils';
import type { UsageData } from '@/lib/energy-repo';
import { wattsToKilowatts } from '@/lib/energy-utils';
import { energyColors } from '@/lib/energy-colors';

export interface DailyByPeriodTableProps {
    today: UsageData[];
}

export function DailyByPeriodTable({ today }: DailyByPeriodTableProps) {
    if (today.length === 0) {
        return (
            <p className="text-sm text-gray-500 dark:text-gray-400">No usage recorded yet today.</p>
        );
    }

    const fmtSigned = (kwh: number) => `${kwh >= 0 ? '+' : '−'}${Math.abs(kwh).toFixed(1)}`;

    return (
        <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
                <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-slate-700 dark:text-gray-400">
                        <th className="py-2 pr-4">Period</th>
                        <th className="py-2 pr-4 text-right">Grid</th>
                        <th className="py-2 pr-4 text-right">Solar</th>
                        <th className="py-2 pr-4 text-right">Used</th>
                    </tr>
                </thead>
                <tbody>
                    {today.map((u) => {
                        const name = u.touName ?? 'Unknown';
                        const solarKwh = wattsToKilowatts(u.solarProduction);
                        const homeKwh = wattsToKilowatts(u.homeUsage);
                        // gridUsage positive = import; net export = -gridUsage.
                        const netExportKwh = -wattsToKilowatts(u.gridUsage);
                        return (
                            <tr key={`${u.tariff.id}|${name}`} className="border-b border-slate-100 dark:border-slate-800">
                                <td className="py-2 pr-4">{formatTouName(name)}</td>
                                <td className={`py-2 pr-4 text-right ${energyColors.grid.text}`}>
                                    {fmtSigned(netExportKwh)} kWh
                                </td>
                                <td className={`py-2 pr-4 text-right ${energyColors.solar.text}`}>{solarKwh.toFixed(1)} kWh</td>
                                <td className={`py-2 pr-4 text-right ${energyColors.load.text}`}>{homeKwh.toFixed(1)} kWh</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
