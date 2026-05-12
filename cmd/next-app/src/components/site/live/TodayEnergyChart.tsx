import type { EnergyData } from '@/lib/db';
import { energyToAveragePower, wattsToKilowatts } from '@/lib/energy-utils';
import { energyColors } from '@/lib/energy-colors';


export interface TodayEnergyChartProps {
    rows: EnergyData[];
    todayStart: Date;
    now: Date;
    timezone: string;
    currentPower?: {
        solar: number;
        grid: number;
        load: number;
        battery: number;
    };
}

const WIDTH = 800;
const HEIGHT = 240;
const PADDING = { top: 16, right: 14, bottom: 28, left: 36 };

/**
 * Inline SVG line chart matching the look of the Trmnl "today" energy chart,
 * but with web colors. Four series — Solar (amber), Grid (brown), Usage (purple),
 * Battery (emerald, dashed). Spans site-local midnight → now, with hour labels
 * every 6 hours.
 */
export function TodayEnergyChart({ rows, todayStart, now, timezone, currentPower }: TodayEnergyChartProps) {
    if (rows.length < 2) {
        return (
            <div className="flex h-48 items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                Not enough data yet today to plot — check back after the next sync.
            </div>
        );
    }

    const startTime = todayStart.getTime();
    const endTime = now.getTime();
    const duration = Math.max(1, endTime - startTime);

    // Convert 5-min Wh → average kW for plotting.
    const series = rows.map((r) => ({
        t: r.timestamp.getTime(),
        solarKw: wattsToKilowatts(energyToAveragePower(r.solar_power)),
        gridKw: wattsToKilowatts(energyToAveragePower(r.grid_power)),
        batteryKw: wattsToKilowatts(energyToAveragePower(r.battery_power)),
        loadKw: wattsToKilowatts(energyToAveragePower(r.load_power))
    }));

    let maxKw = 1;
    let minKw = 0;
    for (const p of series) {
        maxKw = Math.max(maxKw, p.solarKw, p.gridKw, p.batteryKw, p.loadKw);
        minKw = Math.min(minKw, p.solarKw, p.gridKw, p.batteryKw, p.loadKw);
    }
    const yMax = Math.max(1, Math.ceil(maxKw * 1.10));
    const yMin = minKw < 0 ? Math.max(-10, Math.floor(minKw * 1.15)) : 0;
    const yRange = Math.max(0.1, yMax - yMin);

    const plotW = WIDTH - PADDING.left - PADDING.right;
    const plotH = HEIGHT - PADDING.top - PADDING.bottom;
    const getX = (ts: number) => PADDING.left + ((ts - startTime) / duration) * plotW;
    const getY = (kw: number) => PADDING.top + ((yMax - kw) / yRange) * plotH;

    const buildPath = (key: 'solarKw' | 'gridKw' | 'batteryKw' | 'loadKw') =>
        series.map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(p.t).toFixed(2)} ${getY(p[key]).toFixed(2)}`).join(' ');

    // Y-axis grid lines / labels: include zero when negatives are present.
    const yTicks: number[] = yMin < 0
        ? (yMax >= 2 ? [yMin, 0, Math.round(yMax / 2), yMax] : [yMin, 0, yMax])
        : (yMax >= 2 ? [0, Math.round(yMax / 2), yMax] : [0, yMax]);

    // X-axis labels at every 6h boundary in the site's local timezone.
    const hourLabels: { x: number; label: string }[] = [];
    const hourFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: 'numeric', hour12: true
    });
    for (let h = 0; h <= 24; h += 6) {
        const ts = startTime + h * 60 * 60 * 1000;
        if (ts > endTime) break;
        const x = getX(ts);
        // "12 AM" → "12am" to match Trmnl style.
        const label = hourFmt.format(new Date(ts)).replace(/\s/g, '').toLowerCase();
        hourLabels.push({ x, label });
    }

    return (
        <div className="w-full">
            <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-gray-600 dark:text-gray-300">
                <LegendSwatch
                    label="Solar"
                    strokeClass={energyColors.solar.stroke}
                    kw={currentPower?.solar}
                />
                <LegendSwatch
                    label="Grid"
                    strokeClass={energyColors.grid.stroke}
                    kw={currentPower?.grid}
                />
                <LegendSwatch
                    label="Usage"
                    strokeClass={energyColors.load.stroke}
                    kw={currentPower?.load}
                />
                <LegendSwatch
                    label="Battery"
                    strokeClass={energyColors.battery.stroke}
                    dashed
                    kw={currentPower?.battery}
                />
            </div>
            <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                className="w-full h-56"
                preserveAspectRatio="none"
                role="img"
                aria-label="Today's energy chart"
            >
                {yTicks.map((v, i) => {
                    const y = getY(v);
                    const isZero = v === 0;
                    return (
                        <g key={`ytick-${i}`}>
                            <line
                                x1={PADDING.left} y1={y} x2={WIDTH - PADDING.right} y2={y}
                                className={isZero ? 'stroke-slate-400 dark:stroke-slate-500' : 'stroke-slate-200 dark:stroke-slate-700'}
                                strokeWidth={isZero ? 1.25 : 1}
                                vectorEffect="non-scaling-stroke"
                            />
                            <text
                                x={PADDING.left - 4} y={y + 4}
                                className="fill-gray-500 dark:fill-gray-400"
                                fontSize={11} textAnchor="end"
                            >{v}</text>
                        </g>
                    );
                })}

                <path d={buildPath('solarKw')} fill="none"
                    className={energyColors.solar.stroke}
                    strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />

                <path d={buildPath('gridKw')} fill="none"
                    className={energyColors.grid.stroke}
                    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />

                <path d={buildPath('loadKw')} fill="none"
                    className={energyColors.load.stroke}
                    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />

                <path d={buildPath('batteryKw')} fill="none"
                    className={energyColors.battery.stroke}
                    strokeWidth={1.75} strokeDasharray="4 4" strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />

                {hourLabels.map((l, i) => (
                    <text
                        key={`hl-${i}`}
                        x={l.x} y={HEIGHT - 8}
                        className="fill-gray-500 dark:fill-gray-400"
                        fontSize={11} textAnchor="middle"
                    >{l.label}</text>
                ))}
            </svg>
        </div>
    );
}

interface LegendSwatchProps {
    label: string;
    strokeClass: string;
    dashed?: boolean;
    kw?: number;
}

function LegendSwatch({ label, strokeClass, dashed, kw }: LegendSwatchProps) {
    const kwStr = kw !== undefined ? `${(kw / 1000).toFixed(1)} kW` : '';

    return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <svg viewBox="0 0 20 4" className="h-1 w-5" aria-hidden="true">
                <line
                    x1="0" y1="2" x2="20" y2="2"
                    className={strokeClass}
                    strokeWidth="2"
                    strokeDasharray={dashed ? '3 2' : undefined}
                    strokeLinecap="round"
                />
            </svg>
            <span className="font-medium">{label}:</span>
            <span className="tabular-nums">
                {kwStr}
            </span>
        </span>
    );
}


