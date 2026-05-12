import type { EnergyData } from '@/lib/db';
import { energyToAveragePower } from '@/lib/energy-utils';

type SparklineMetricKey = 'solar' | 'grid' | 'load';

export const SPARKLINE_DISPLAY_WINDOW_HOURS = 24;
export const DEFAULT_SPARKLINE_SCALE_WINDOW_HOURS = 24;

interface SparklinePoint {
    timestamp: string;
    watts: number;
}

interface SparklineSeries {
    solar: SparklinePoint[];
    grid: SparklinePoint[];
    load: SparklinePoint[];
}

interface SparklineScale {
    minWatts: number;
    maxWatts: number;
}

interface SparklineScales {
    solar: SparklineScale;
    grid: SparklineScale;
    load: SparklineScale;
}

export function parseScaleWindowHours(rawValue: string | undefined): number {
    if (!rawValue) return DEFAULT_SPARKLINE_SCALE_WINDOW_HOURS;

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SPARKLINE_SCALE_WINDOW_HOURS;

    // Keep scale horizon at least as wide as the displayed sparkline window.
    return Math.max(parsed, SPARKLINE_DISPLAY_WINDOW_HOURS);
}

export function toSparklinePayload(historyRows: EnergyData[], liveTimestamp: Date, liveValues: {
    solar: number;
    grid: number;
    load: number;
}, displayStart: Date): { series: SparklineSeries; scales: SparklineScales } {
    const history: Record<SparklineMetricKey, SparklinePoint[]> = {
        // EnergyData stores interval energy (Wh); convert to average watts to match live Tesla readings.
        solar: historyRows.map((row) => ({ timestamp: row.timestamp.toISOString(), watts: energyToAveragePower(row.solar_power) })),
        grid: historyRows.map((row) => ({ timestamp: row.timestamp.toISOString(), watts: energyToAveragePower(row.grid_power) })),
        load: historyRows.map((row) => ({ timestamp: row.timestamp.toISOString(), watts: energyToAveragePower(row.load_power) })),
    };

    const liveIso = liveTimestamp.toISOString();

    const withLivePoint = (metric: SparklineMetricKey): SparklinePoint[] => {
        const points = history[metric];
        const livePoint: SparklinePoint = { timestamp: liveIso, watts: liveValues[metric] };
        const lastPoint = points.at(-1);

        if (lastPoint?.timestamp === liveIso) {
            return [...points.slice(0, -1), livePoint];
        }

        return [...points, livePoint];
    };

    const displayStartIso = displayStart.toISOString();
    const fullSeries: SparklineSeries = {
        solar: withLivePoint('solar'),
        grid: withLivePoint('grid'),
        load: withLivePoint('load'),
    };

    const toScale = (points: SparklinePoint[]): SparklineScale => {
        if (points.length === 0) {
            return { minWatts: 0, maxWatts: 0 };
        }

        const watts = points.map((point) => point.watts);
        return {
            minWatts: Math.min(...watts),
            maxWatts: Math.max(...watts),
        };
    };

    return {
        series: {
            solar: fullSeries.solar.filter((point) => point.timestamp >= displayStartIso),
            grid: fullSeries.grid.filter((point) => point.timestamp >= displayStartIso),
            load: fullSeries.load.filter((point) => point.timestamp >= displayStartIso),
        },
        scales: {
            solar: toScale(fullSeries.solar),
            grid: toScale(fullSeries.grid),
            load: toScale(fullSeries.load),
        },
    };
}
