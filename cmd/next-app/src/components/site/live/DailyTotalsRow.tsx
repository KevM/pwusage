import type { TodayTotals } from '@/lib/energy-repo';
import { energyColors } from '@/lib/energy-colors';
import { BatteryStatus, BatteryStatusGlyph, BatteryGlyph } from './BatteryIcons';

export function getBatteryStatus(power: number): BatteryStatus {
    if (power < -50) return 'charging';
    if (power > 50) return 'discharging';
    return 'idle';
}

export interface DailyTotalsRowProps {
    totals: TodayTotals;
    soc: number | null;
    batteryPower: number;
}


interface TileProps {
    label: string;
    value: string;
    metric: keyof typeof energyColors;
    children?: React.ReactNode;
}

function Tile({ label, value, metric, children }: TileProps) {
    const c = energyColors[metric];
    return (
        <div className={`rounded border-l-4 ${c.borderAccent} ${c.tileBg} p-3 flex flex-col justify-between`}>
            <div>
                <p className="text-xs text-gray-600 dark:text-gray-400">{label}</p>
                <p className={`text-lg font-semibold ${c.text}`}>{value}</p>
            </div>
            {children}
        </div>
    );
}

export function DailyTotalsRow({ totals, soc, batteryPower }: DailyTotalsRowProps) {
    const fmt = (n: number) => n.toFixed(1);
    // gridNetKwh > 0 → net draw from grid (deficit); < 0 → net export (surplus).
    const gridArrow = totals.gridNetKwh > 0 ? '↓' : totals.gridNetKwh < 0 ? '↑' : '';
    const gridValue = `${gridArrow ? `${gridArrow} ` : ''}${fmt(totals.gridNetKwh)} kWh`;
    // batteryNetKwh > 0 → net discharge; < 0 → net charge.
    const batteryArrow = totals.batteryNetKwh > 0 ? '↓' : totals.batteryNetKwh < 0 ? '↑' : '';
    const batteryValue = `${batteryArrow ? `${batteryArrow} ` : ''}${fmt(totals.batteryNetKwh)} kWh`;

    const status = getBatteryStatus(batteryPower);
    const c = energyColors.battery;
    const hasSoc = soc !== null;
    const level = hasSoc ? Math.max(0, Math.min(100, soc)) : 0;
    const socText = hasSoc ? `${Math.round(level)}%` : '--%';

    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Today: Grid"    metric="grid"     value={gridValue} />
            <Tile label="Today: Solar"   metric="solar"    value={`${fmt(totals.solarKwh)} kWh`} />
            <Tile label="Today: Used"    metric="load"     value={`${fmt(totals.homeKwh)} kWh`} />
            
            <div className={`rounded border-l-4 ${c.borderAccent} ${c.tileBg} p-3 flex flex-col justify-between`}>
                <div>
                    <p className="text-xs text-gray-600 dark:text-gray-400">Today: Battery</p>
                    <div className="flex items-center gap-2">
                        <span className={`text-lg font-semibold ${c.text}`}>{socText}</span>
                        <div className="relative">
                            <BatteryGlyph
                                level={level}
                                strokeClass={c.stroke}
                                fillClass={c.text.replace('text-', 'fill-')}
                                className="h-5 w-10"
                            />
                            <div className="absolute -right-4 -top-1">
                                <BatteryStatusGlyph status={status} className={c.text} size="h-3.5 w-3.5" />
                            </div>
                        </div>
                    </div>
                </div>
                <div className="mt-2 border-t border-emerald-500/10 pt-1">
                    <p className={`text-lg font-semibold ${c.text}`}>{batteryValue}</p>
                </div>
            </div>
        </div>
    );
}






