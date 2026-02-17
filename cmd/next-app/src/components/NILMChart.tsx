'use client';

import React from 'react';
import {
    LineChart,
    Line,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceArea,
    ReferenceLine
} from 'recharts';
import { PowerData } from '@/lib/nilm/types';
import { LoadEvent } from '@/lib/nilm/load-detection';
import { buildSocCheckpoints } from '@/lib/soc-checkpoints';

interface NILMChartProps {
    data: PowerData[];
    events: LoadEvent[];
    tariffs?: Record<number, string>;
    highlightedEvent?: LoadEvent | null;
    selectedEvent?: LoadEvent | null;
    onEventClick?: (event: LoadEvent) => void;
    isDarkMode?: boolean;
    siteTimezone?: string;
    displayMode?: 'SITE' | 'BROWSER';
}

// Helper to format tariff names (e.g., SUPER_OFF_PEAK -> Super Off-Peak)
const formatTariffName = (name: string | undefined) => {
    if (!name) return undefined;
    if (name.includes('Tariff')) return name; // Don't format "Tariff 1"

    return name
        .toLowerCase()
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
        .replace('Of ', 'of ')
        .replace('Ex ', 'ex ')
        .replace('On Peak', 'On-Peak')
        .replace('Off Peak', 'Off-Peak');
};

// Helper to safely parse dates
const parseDate = (val: string | Date | number) => {
    if (typeof val === 'number') return new Date(val);
    if (val instanceof Date) return val;
    return new Date(String(val).replace(' ', 'T'));
};

interface CustomTickProps {
    x?: number;
    y?: number;
    payload?: { value: number };
    xAxisConfig: { transitionTimes: Set<number> };
    themeColors: { axis: string; text: string };
}

interface ThemeColors {
    gridLines: string;
    axis: string;
    cursor: string;
    text: string;
    solar: string;
    battery: string;
    soc: string;
    load: string;
    gridTrace: string;
}

interface TooltipProps {
    active?: boolean;
    payload?: {
        value: number | string;
        payload: PowerData & {
            touName?: string;
            tariffId?: number;
            batterySoc?: number | null;
            batterySocInterpolated?: number | null;
        };
    }[];
    label?: string | number;
    events?: (LoadEvent & { index: number; startMs: number; endMs: number })[];
    tariffs?: Record<number, string>;
    isDarkMode?: boolean;

    themeColors?: ThemeColors;
}

function BatteryGlyph({ level, color, stroke }: { level: number; color: string; stroke: string }) {
    const clamped = Math.max(0, Math.min(100, level));
    const fillWidth = (clamped / 100) * 14;
    return (
        <svg width="22" height="13" viewBox="0 0 22 13" aria-hidden="true">
            <rect x="1" y="1.5" width="16" height="10" rx="1.8" fill="none" stroke={stroke} strokeWidth="1.4" />
            <rect x="17.5" y="4" width="3" height="5" rx="1" fill={stroke} />
            <rect x="2.5" y="3" width={fillWidth} height="7" rx="0.8" fill={color} />
        </svg>
    );
}

const TooltipContent = ({ active, payload, label, events, tariffs, isDarkMode, themeColors, siteTimezone, displayMode }: TooltipProps & { siteTimezone?: string, displayMode?: string }) => {
    if (active && payload && payload.length) {
        const time = Number(label);
        const options: Intl.DateTimeFormatOptions = {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: (displayMode === 'SITE' && siteTimezone) ? siteTimezone : undefined
        };
        const dateOptions: Intl.DateTimeFormatOptions = {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: (displayMode === 'SITE' && siteTimezone) ? siteTimezone : undefined
        };
        const timeStr = new Intl.DateTimeFormat([], options).format(time);
        const dateStr = new Intl.DateTimeFormat([], dateOptions).format(time);

        const dataPoint = payload[0].payload;

        // Use pre-calculated touName from backend if available, otherwise fallback
        const touName = dataPoint.touName;
        const tariffId = dataPoint.tariffId;

        const rawName = touName || (
            (tariffs && tariffId !== undefined)
                ? (tariffs[tariffId] || `Tariff ${tariffId}`)
                : undefined
        );

        const displayName = formatTariffName(rawName);
        const isPeak = displayName?.toLowerCase().includes('peak') && !displayName?.toLowerCase().includes('off');

        // Find active event
        const activeEvent = events?.find(e => time >= e.startMs && time <= e.endMs);

        const colors = {
            bg: isDarkMode ? 'rgba(17, 24, 39, 1)' : 'rgba(255, 255, 255, 1)',
            border: isDarkMode ? '#374151' : '#e5e7eb',
            text: isDarkMode ? '#f3f4f6' : '#111827',
            subText: isDarkMode ? '#d1d5db' : '#374151',
            dateText: isDarkMode ? '#9ca3af' : '#6b7280',
            loadBg: isDarkMode ? 'rgba(147, 51, 234, 0.1)' : 'rgba(147, 51, 234, 0.05)',
            loadText: isDarkMode ? '#c084fc' : '#9333ea',
            kWVal: isDarkMode ? '#22d3ee' : '#0891b2',
            solar: isDarkMode ? '#fbbf24' : '#d97706', // Amber-400 / Amber-600
            battery: isDarkMode ? '#4ade80' : '#10b981', // Green-400 / Green-500
            load: isDarkMode ? '#c084fc' : '#9333ea', // Purple-400 / Purple-600

            grid: themeColors ? themeColors.gridTrace : (isDarkMode ? '#A67B5B' : '#6F4E37'), // Fallback to avoid crash if themeColors missing
        };

        return (
            <div
                className="rounded-xl shadow-2xl z-50 min-w-[200px]"
                style={{
                    backgroundColor: colors.bg,
                    border: `1px solid ${colors.border}`,
                    padding: '12px',
                    color: colors.text
                }}
            >
                <div className="flex justify-between items-start mb-3 border-b pb-2" style={{ borderColor: colors.border }}>
                    <div>
                        <p style={{ color: colors.subText, fontWeight: 500 }}>{timeStr}</p>
                        <p style={{ color: colors.dateText, fontSize: '10px' }}>{dateStr}</p>
                    </div>
                    {displayName && (
                        <div className="text-right">
                            <span
                                className="block px-2 py-0.5 rounded-full text-[10px] border font-medium"
                                style={{
                                    backgroundColor: isPeak ? 'rgba(136, 19, 55, 0.4)' : 'rgba(6, 78, 59, 0.4)',
                                    borderColor: isPeak ? '#9f1239' : '#065f46',
                                    color: isPeak ? '#fda4af' : '#6ee7b7'
                                }}
                            >
                                {displayName}
                            </span>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-between gap-4 mb-1">
                    <span style={{ color: colors.load }}>Load</span>
                    <span style={{ color: colors.load, fontWeight: 'bold', fontSize: '14px' }}>{(Number(payload[0].value) / 1000).toFixed(2)} kW</span>
                </div>
                {payload[0].payload.solarWatts !== undefined && (
                    <div className="flex items-center justify-between gap-4 mb-1">
                        <span style={{ color: colors.solar }}>Solar</span>
                        <span style={{ color: colors.solar, fontWeight: 'bold', fontSize: '14px' }}>{(Number(payload[0].payload.solarWatts) / 1000).toFixed(2)} kW</span>
                    </div>
                )}
                {payload[0].payload.batteryWatts !== undefined && (
                    <div className="flex items-center justify-between gap-4 mb-1">
                        <span style={{ color: colors.battery }}>Battery</span>
                        <span style={{ color: colors.battery, fontWeight: 'bold', fontSize: '14px' }}>{(Number(payload[0].payload.batteryWatts) / 1000).toFixed(2)} kW</span>
                    </div>
                )}
                {payload[0].payload.gridWatts !== undefined && (
                    <div className="flex items-center justify-between gap-4 mb-1">
                        <span style={{ color: colors.grid }}>Grid</span>
                        <span style={{ color: colors.grid, fontWeight: 'bold', fontSize: '14px' }}>{(Number(payload[0].payload.gridWatts) / 1000).toFixed(2)} kW</span>
                    </div>
                )}
                {typeof payload[0].payload.batterySocInterpolated === 'number' && (
                    <div className="flex items-center justify-between gap-4 mb-1">
                        <span style={{ color: themeColors?.battery ?? colors.battery }}>Battery SoC</span>
                        <span style={{ color: themeColors?.battery ?? colors.battery, fontWeight: 'bold', fontSize: '14px' }}>{payload[0].payload.batterySocInterpolated.toFixed(1)}%</span>
                    </div>
                )}

                {activeEvent && (
                    <div className="mt-3 pt-3 border-t -mx-4 px-4 pb-1" style={{ backgroundColor: colors.loadBg, borderColor: colors.border }}>
                        <div className="flex justify-between items-center mb-2">
                            <span style={{ color: colors.loadText, fontWeight: 'bold' }}>Load #{activeEvent.index + 1}</span>
                            <span style={{ fontSize: '10px', color: colors.loadText, borderColor: colors.loadText, borderWidth: '1px', padding: '0 4px', borderRadius: '4px', opacity: 0.7 }}>DETECTED LOAD</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1" style={{ color: colors.dateText }}>
                            <span>Duration</span> <span style={{ color: colors.text, textAlign: 'right' }}>{activeEvent.durationMinutes}m</span>
                            <span>Energy</span> <span style={{ color: '#4ade80', textAlign: 'right' }}>{activeEvent.kwh} kWh</span>
                            <span>Avg Pwr</span> <span style={{ color: colors.text, textAlign: 'right' }}>{(activeEvent.averagePower / 1000).toFixed(1)} kW</span>
                        </div>

                        {activeEvent.tags && activeEvent.tags.length > 0 && (
                            <div className="mt-3 text-xs flex flex-wrap gap-1">
                                {activeEvent.tags.map((tag: string) => (
                                    <span key={tag} className="px-1.5 py-0.5 rounded bg-blue-900/10 text-blue-600 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }
    return null;
};

const CustomTick = ({ x, y, payload, xAxisConfig, themeColors, siteTimezone, displayMode }: CustomTickProps & { siteTimezone?: string, displayMode?: string }) => {
    if (!payload || x === undefined || y === undefined) return null;
    const time = payload.value;
    const tz = (displayMode === 'SITE' && siteTimezone) ? siteTimezone : undefined;

    // We need the hour/minute in the target timezone to determine if it's a major/whole hour
    const fmt = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
        timeZone: tz
    });
    const parts = fmt.formatToParts(time);
    const p: Record<string, string> = {};
    parts.forEach(part => p[part.type] = part.value);

    const hour = parseInt(p.hour, 10);
    const minute = parseInt(p.minute, 10);

    const isTransition = xAxisConfig.transitionTimes.has(time);
    const isWholeHour = minute === 0;
    const isMajorHour = isWholeHour && (hour % 4 === 0);

    const isMajor = isTransition || isMajorHour;
    const isMinor = isWholeHour && !isMajor;

    const lineHeight = isMajor ? 10 : 5;
    const lineOpacity = isMajor ? 0.6 : 0.2;

    let label = null;

    if (isTransition) {
        label = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(time).toLowerCase().replace(' ', '');
    } else if (isMajorHour) {
        label = new Intl.DateTimeFormat([], { hour: 'numeric', timeZone: tz }).format(time).toLowerCase().replace(' ', '');
    }

    if (!isMajor && !isMinor) return null;

    return (
        <g transform={`translate(${x},${y})`}>
            <line x1={0} y1={0} x2={0} y2={lineHeight} stroke={themeColors.axis} strokeOpacity={lineOpacity} />
            {label && (
                <text
                    x={0}
                    y={lineHeight + 12}
                    textAnchor="middle"
                    fill={themeColors.text}
                    fontSize={10}
                    fontWeight={isTransition ? "bold" : "normal"}
                >
                    {label}
                </text>
            )}
        </g>
    );
};

export default function NILMChart({ data, events, tariffs, highlightedEvent, selectedEvent, onEventClick, isDarkMode = true, siteTimezone, displayMode }: NILMChartProps) {
    const [hoverTime, setHoverTime] = React.useState<number | null>(null);
    const [isCompactSocView, setIsCompactSocView] = React.useState(false);
    const [visibleSeries, setVisibleSeries] = React.useState({
        load: true,
        solar: true,
        battery: true,
        grid: true
    });

    const toggleSeries = (key: keyof typeof visibleSeries) => {
        setVisibleSeries(prev => {
            // Prevent disabling the last visible series
            if (prev[key] && Object.values(prev).filter(Boolean).length <= 1) {
                return prev;
            }
            return { ...prev, [key]: !prev[key] };
        });
    };

    const isToggleDisabled = (key: keyof typeof visibleSeries) => {
        return visibleSeries[key] && Object.values(visibleSeries).filter(Boolean).length <= 1;
    };

    React.useEffect(() => {
        const media = window.matchMedia('(max-width: 1024px)');
        const update = () => setIsCompactSocView(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    const sharedYAxisWidth = 72;
    const sharedChartMargin = { top: 0, right: 10, left: 0, bottom: 0 };

    const themeColors = React.useMemo(() => ({
        gridLines: isDarkMode ? "#374151" : "#e5e7eb",
        axis: isDarkMode ? "#9CA3AF" : "#6B7280",
        cursor: isDarkMode ? "#6B7280" : "#9CA3AF",
        text: isDarkMode ? "#9CA3AF" : "#6B7280",
        solar: isDarkMode ? "#fbbf24" : "#f59e0b",
        battery: isDarkMode ? "#4ade80" : "#10b981",
        soc: isDarkMode ? "#86efac" : "#166534",
        load: isDarkMode ? "#c084fc" : "#9333ea", // Purple-400 / Purple-600
        gridTrace: isDarkMode ? "#A67B5B" : "#6F4E37"  // Cocoa Brown (Dark/Light)
    }), [isDarkMode]);

    const getDisplayTime = React.useCallback((val: string | Date | number) => {
        return parseDate(val);
    }, []);

    const processedEvents = React.useMemo(() => {
        return events.map((e, index) => ({
            ...e,
            index,
            startMs: getDisplayTime(e.startTime).getTime(),
            endMs: getDisplayTime(e.endTime).getTime()
        }));
    }, [events, getDisplayTime]);

    const formattedData = React.useMemo(() => {
        const baseRows = data.map(d => {
            const dt = getDisplayTime(d.timestamp);
            return {
                ...d,
                time: dt.getTime(),
                datetime: dt.toLocaleString(),
                batterySocInterpolated: typeof d.batterySoc === 'number' ? d.batterySoc : null as number | null
            };
        });

        const knownIndexes: number[] = [];
        for (let i = 0; i < baseRows.length; i++) {
            if (typeof baseRows[i].batterySocInterpolated === 'number') knownIndexes.push(i);
        }
        if (knownIndexes.length === 0) return baseRows;

        const firstKnown = knownIndexes[0];
        const lastKnown = knownIndexes[knownIndexes.length - 1];

        // Extend edge segments with nearest known value so the strip stays continuous.
        for (let i = 0; i < firstKnown; i++) {
            baseRows[i].batterySocInterpolated = baseRows[firstKnown].batterySocInterpolated;
        }
        for (let i = lastKnown + 1; i < baseRows.length; i++) {
            baseRows[i].batterySocInterpolated = baseRows[lastKnown].batterySocInterpolated;
        }

        // Fill interior gaps with linear interpolation between known samples.
        for (let k = 0; k < knownIndexes.length - 1; k++) {
            const leftIdx = knownIndexes[k];
            const rightIdx = knownIndexes[k + 1];
            const left = baseRows[leftIdx].batterySocInterpolated;
            const right = baseRows[rightIdx].batterySocInterpolated;
            if (left === null || right === null) continue;

            const span = rightIdx - leftIdx;
            if (span <= 1) continue;

            for (let i = leftIdx + 1; i < rightIdx; i++) {
                const t = (i - leftIdx) / span;
                baseRows[i].batterySocInterpolated = left + (right - left) * t;
            }
        }

        // Apply a light centered moving average to reduce visual stair-stepping.
        const windowRadius = 2;
        for (let i = 0; i < baseRows.length; i++) {
            let sum = 0;
            let count = 0;
            for (let j = i - windowRadius; j <= i + windowRadius; j++) {
                if (j < 0 || j >= baseRows.length) continue;
                const v = baseRows[j].batterySocInterpolated;
                if (typeof v === 'number') {
                    sum += v;
                    count++;
                }
            }
            baseRows[i].batterySocInterpolated = count > 0 ? sum / count : null;
        }

        return baseRows;
    }, [data, getDisplayTime]);

    const tariffRegions = React.useMemo(() => {
        if (!formattedData.length) return [];
        const regions: { start: number, end: number, name: string }[] = [];

        let currentStart = formattedData[0].time;
        let currentName = formattedData[0].touName || (formattedData[0].tariffId ? tariffs?.[formattedData[0].tariffId] : 'Unknown');

        for (let i = 1; i < formattedData.length; i++) {
            const point = formattedData[i];
            const pointExample = point.touName || (point.tariffId ? tariffs?.[point.tariffId] : 'Unknown');

            if (pointExample !== currentName) {
                regions.push({
                    start: currentStart,
                    end: point.time,
                    name: currentName || 'Unknown'
                });
                currentStart = point.time;
                currentName = pointExample;
            }
        }
        if (formattedData.length > 0) {
            const lastPoint = formattedData[formattedData.length - 1];
            const lastName = lastPoint.touName || (lastPoint.tariffId != null ? tariffs?.[lastPoint.tariffId] : undefined) || 'Unknown';
            regions.push({
                start: currentStart,
                end: lastPoint.time,
                name: lastName
            });
        }
        return regions;
    }, [formattedData, tariffs]);

    const xAxisConfig = React.useMemo(() => {
        if (!formattedData.length) return { ticks: [], transitionTimes: new Set<number>() };

        const start = formattedData[0].time;
        const end = formattedData[formattedData.length - 1].time;
        const ticks = new Set<number>();
        const transitionTimes = new Set<number>();

        tariffRegions.forEach(r => {
            ticks.add(r.start);
            transitionTimes.add(r.start);
        });

        const tz = (displayMode === 'SITE' && siteTimezone) ? siteTimezone : undefined;
        const startDate = new Date(start);

        const fmt = new Intl.DateTimeFormat('en-US', {
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
            hour12: false, timeZone: tz
        });
        const parts = fmt.formatToParts(startDate);
        const p: Record<string, number> = {};
        parts.forEach(part => { if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10); });

        let current = start;
        const minuteOffset = (p.minute || 0) * 60 * 1000;
        if (minuteOffset > 0) current += (3600 * 1000 - minuteOffset);

        while (current <= end) {
            ticks.add(current);
            current += 3600 * 1000;
        }

        return {
            ticks: Array.from(ticks).sort((a, b) => a - b),
            transitionTimes
        };
    }, [formattedData, tariffRegions, displayMode, siteTimezone]);

    const socCheckpoints = React.useMemo(() => {
        if (formattedData.length === 0) return [];

        const tz = (displayMode === 'SITE' && siteTimezone) ? siteTimezone : undefined;
        const hmFormatter = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric',
            minute: 'numeric',
            hour12: false,
            timeZone: tz
        });

        const samples = formattedData
            .map((row) => {
                if (typeof row.batterySocInterpolated !== 'number') return null;
                const parts = hmFormatter.formatToParts(row.time);
                const p: Record<string, string> = {};
                parts.forEach((part) => { p[part.type] = part.value; });
                const hour = parseInt(p.hour, 10);
                const minute = parseInt(p.minute, 10);
                return {
                    time: row.time,
                    soc: row.batterySocInterpolated,
                    isAnchor: minute === 0 && hour % 4 === 0
                };
            })
            .filter((row): row is { time: number; soc: number; isAnchor: boolean } => row !== null);

        if (samples.length === 0) return [];
        const anchorTimestamps = samples.filter((s) => s.isAnchor).map((s) => s.time);
        return buildSocCheckpoints({
            samples: samples.map((s) => ({ timestamp: s.time, soc: s.soc })),
            startTime: samples[0].time,
            endTime: samples[samples.length - 1].time,
            anchorTimestamps,
            baseAnchorMs: 4 * 60 * 60 * 1000,
            rapidAnchorMs: 2 * 60 * 60 * 1000,
            deltaThreshold: 20,
            rapidSegmentDeltaThreshold: 20
        });
    }, [formattedData, displayMode, siteTimezone]);




    if (!data || data.length === 0) {
        return (
            <div className={`w-full h-[500px] flex items-center justify-center rounded-xl border ${isDarkMode ? 'bg-gray-900/50 border-gray-800 text-gray-500' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
                No graph data available to display.
            </div>
        );
    }

    const socMinTime = formattedData[0]?.time ?? 0;
    const socMaxTime = formattedData[formattedData.length - 1]?.time ?? socMinTime;
    const socRange = Math.max(1, socMaxTime - socMinTime);

    return (
        <div className="w-full h-full">
            <div className="flex flex-wrap items-center gap-4 mb-4 text-xs font-medium select-none">
                <label
                    className={`flex items-center gap-2 cursor-pointer transition-opacity ${visibleSeries.load ? 'opacity-100' : 'opacity-40 hover:opacity-60'} ${isToggleDisabled('load') ? 'opacity-50 cursor-not-allowed' : ''}`}
                    onClick={(e) => {
                        e.preventDefault();
                        if (!isToggleDisabled('load')) toggleSeries('load');
                    }}
                >
                    <div className={`w-3 h-3 rounded-full ${visibleSeries.load ? '' : 'ring-1 ring-offset-1 ring-offset-transparent'}`}
                        style={{
                            backgroundColor: visibleSeries.load ? themeColors.load : 'transparent',
                            borderColor: themeColors.load,
                            borderWidth: visibleSeries.load ? 0 : 1
                        }}
                    />
                    <input type="checkbox" className="hidden" checked={visibleSeries.load} readOnly />
                    <span style={{ color: themeColors.text }}>Load</span>
                </label>

                <label
                    className={`flex items-center gap-2 cursor-pointer transition-opacity ${visibleSeries.solar ? 'opacity-100' : 'opacity-40 hover:opacity-60'} ${isToggleDisabled('solar') ? 'opacity-50 cursor-not-allowed' : ''}`}
                    onClick={(e) => {
                        e.preventDefault();
                        if (!isToggleDisabled('solar')) toggleSeries('solar');
                    }}
                >
                    <div className={`w-3 h-3 rounded-full ${visibleSeries.solar ? '' : 'ring-1 ring-offset-1 ring-offset-transparent'}`}
                        style={{
                            backgroundColor: visibleSeries.solar ? themeColors.solar : 'transparent',
                            borderColor: themeColors.solar,
                            borderWidth: visibleSeries.solar ? 0 : 1
                        }}
                    />
                    <input type="checkbox" className="hidden" checked={visibleSeries.solar} readOnly />
                    <span style={{ color: themeColors.text }}>Solar</span>
                </label>

                <label
                    className={`flex items-center gap-2 cursor-pointer transition-opacity ${visibleSeries.battery ? 'opacity-100' : 'opacity-40 hover:opacity-60'} ${isToggleDisabled('battery') ? 'opacity-50 cursor-not-allowed' : ''}`}
                    onClick={(e) => {
                        e.preventDefault();
                        if (!isToggleDisabled('battery')) toggleSeries('battery');
                    }}
                >
                    <div className={`w-3 h-3 rounded-full ${visibleSeries.battery ? '' : 'ring-1 ring-offset-1 ring-offset-transparent'}`}
                        style={{
                            backgroundColor: visibleSeries.battery ? themeColors.battery : 'transparent',
                            borderColor: themeColors.battery,
                            borderWidth: visibleSeries.battery ? 0 : 1
                        }}
                    />
                    <input type="checkbox" className="hidden" checked={visibleSeries.battery} readOnly />
                    <span style={{ color: themeColors.text }}>Battery</span>
                </label>

                <label
                    className={`flex items-center gap-2 cursor-pointer transition-opacity ${visibleSeries.grid ? 'opacity-100' : 'opacity-40 hover:opacity-60'} ${isToggleDisabled('grid') ? 'opacity-50 cursor-not-allowed' : ''}`}
                    onClick={(e) => {
                        e.preventDefault();
                        if (!isToggleDisabled('grid')) toggleSeries('grid');
                    }}
                >
                    <div className={`w-3 h-3 rounded-full ${visibleSeries.grid ? '' : 'ring-1 ring-offset-1 ring-offset-transparent'}`}
                        style={{
                            backgroundColor: visibleSeries.grid ? themeColors.gridTrace : 'transparent',
                            borderColor: themeColors.gridTrace,
                            borderWidth: visibleSeries.grid ? 0 : 1
                        }}
                    />
                    <input type="checkbox" className="hidden" checked={visibleSeries.grid} readOnly />
                    <span style={{ color: themeColors.text }}>Grid</span>
                </label>
            </div>

            <div style={{ width: '100%', height: 520 }}>
                <style>{`
                .recharts-wrapper, .recharts-surface, .recharts-layer {
                    outline: none !important;
                }
            `}</style>
                <ResponsiveContainer width="100%" height="82%">
                    <LineChart
                        data={formattedData}
                        syncId="history-power-and-soc"
                        margin={sharedChartMargin}
                        onMouseMove={(state) => {
                            if (state.isTooltipActive && state.activeLabel) {
                                setHoverTime(Number(state.activeLabel));
                            } else {
                                setHoverTime(null);
                            }
                        }}
                        onMouseLeave={() => setHoverTime(null)}
                    >
                        <CartesianGrid strokeDasharray="3 3" stroke={themeColors.gridLines} vertical={false} />
                        <XAxis
                            dataKey="time"
                            type="number"
                            domain={['dataMin', 'dataMax']}
                            ticks={xAxisConfig.ticks}
                            tick={<CustomTick xAxisConfig={xAxisConfig} themeColors={themeColors} siteTimezone={siteTimezone} displayMode={displayMode} />}
                            interval={0}
                            stroke={themeColors.axis}
                            height={40}
                        />
                        <YAxis
                            stroke={themeColors.axis}
                            tickFormatter={(val) => `${(val / 1000).toFixed(1)} kW`}
                            width={sharedYAxisWidth}
                        />

                        {/* Tariff Background Regions - Rendered FIRST to be behind lines */}
                        {tariffRegions.map((region, i) => (
                            <ReferenceArea
                                key={`tariff-${i}`}
                                x1={region.start}
                                x2={region.end}
                                fill={region.name?.toLowerCase().includes('peak') && !region.name?.toLowerCase().includes('off') ? '#ef4444' : '#10b981'}
                                fillOpacity={0.15}
                            />
                        ))}

                        {/* Explicit Vertical Transition Lines */}
                        {tariffRegions.map((region, i) => {
                            if (i === 0) return null;
                            return (
                                <ReferenceLine
                                    key={`trans-line-${i}`}
                                    x={region.start}
                                    stroke={themeColors.axis}
                                    strokeWidth={2}
                                    strokeDasharray="5 5"
                                    strokeOpacity={0.8}
                                />
                            );
                        })}

                        {/* Centered Labels for Tariff Regions - Context Aware Colors */}
                        {tariffRegions.map((region, i) => {
                            const isPeak = region.name?.toLowerCase().includes('peak') && !region.name?.toLowerCase().includes('off');
                            const isOffPeak = region.name?.toLowerCase().includes('off');
                            // Peak = Red-400, Off-Peak = Emerald-400, Else = Gray-400
                            const labelColor = isPeak ? '#f87171' : (isOffPeak ? '#34d399' : themeColors.text);

                            return (
                                <ReferenceArea
                                    key={`label-${i}`}
                                    x1={region.start}
                                    x2={region.end}
                                    fillOpacity={0}
                                    stroke="none"
                                    label={{
                                        value: formatTariffName(region.name),
                                        position: 'insideTop',
                                        fill: labelColor,
                                        fontSize: 12,
                                        fontWeight: 'bold',
                                        offset: 10
                                    }}
                                />
                            );
                        })}

                        {/* Active Event Highlight - Pop Color: Purple */}
                        {processedEvents.map((event, index) => {
                            // isHighlighted triggers the visual POP (solid stroke, higher opacity)
                            // Triggered by:
                            // 1. Mouse hover on chart (time match)
                            // 2. Mouse hover on table (highlightedEvent prop)
                            // 3. Selection (selectedEvent prop)
                            const isHovered = (hoverTime && hoverTime >= event.startMs && hoverTime <= event.endMs) ||
                                (highlightedEvent && new Date(highlightedEvent.startTime).getTime() === event.startMs);

                            const isSelected = selectedEvent && new Date(selectedEvent.startTime).getTime() === event.startMs;

                            // If selected, we might want a distinct style, but for now we reuse the "Pop" style as requested.
                            // "When the user clicks the row. The row and the region are highlighted." -> Persistent Highlight.
                            const active = isHovered || isSelected;

                            return (
                                <ReferenceArea
                                    key={index}
                                    x1={event.startMs}
                                    x2={event.endMs}
                                    stroke={active ? "#db2777" : "transparent"} // Pink-600
                                    strokeWidth={active ? 2 : 0}
                                    strokeOpacity={1}
                                    fill="#a855f7" // Purple-500
                                    fillOpacity={active ? 0.6 : 0.25}
                                    onClick={() => onEventClick && onEventClick(event)}
                                    className="cursor-pointer" // Show pointer to indicate clickable
                                    label={{
                                        value: "Load",
                                        position: 'insideBottom',
                                        fill: active ? (isDarkMode ? '#fdf2f8' : '#faf5ff') : '#c084fc',
                                        fontSize: 12,
                                        fontWeight: 'bold',
                                        offset: 5
                                    }}
                                />
                            );
                        })}

                        <Tooltip
                            content={<TooltipContent events={processedEvents} tariffs={tariffs} isDarkMode={isDarkMode} themeColors={themeColors} siteTimezone={siteTimezone} displayMode={displayMode} />}
                            cursor={{ stroke: themeColors.cursor, strokeWidth: 1, strokeDasharray: '3 3' }}
                            wrapperStyle={{ outline: 'none' }}
                        />
                        <Line
                            type="linear"
                            dataKey="powerWatts"
                            name="Load Power (kW)"
                            stroke={themeColors.load}
                            dot={false}
                            strokeWidth={2}
                            animationDuration={500}
                            hide={!visibleSeries.load}
                            isAnimationActive={false}
                        />

                        <Line
                            type="linear"
                            dataKey="solarWatts"
                            name="Solar (kW)"
                            stroke={themeColors.solar}
                            dot={false}
                            strokeWidth={2}
                            animationDuration={500}
                            hide={!visibleSeries.solar}
                            isAnimationActive={false}
                        />

                        <Line
                            type="linear"
                            dataKey="batteryWatts"
                            name="Battery (kW)"
                            stroke={themeColors.battery}
                            dot={false}
                            strokeWidth={2}
                            animationDuration={500}
                            hide={!visibleSeries.battery}
                            isAnimationActive={false}
                        />

                        <Line
                            type="linear"
                            dataKey="gridWatts"
                            name="Grid (kW)"
                            stroke={themeColors.gridTrace}
                            dot={false}
                            strokeWidth={2}
                            animationDuration={500}
                            hide={!visibleSeries.grid}
                            isAnimationActive={false}
                        />

                    </LineChart>
                </ResponsiveContainer>
                {isCompactSocView ? (
                    <div className="relative w-full h-[54px] mt-1">
                        <div
                            className="absolute top-1 bottom-0"
                            style={{ left: `${sharedYAxisWidth}px`, right: '10px' }}
                        >
                            {socCheckpoints.map((cp, idx) => {
                                const marker = cp.delta === null ? '' : (cp.delta >= 0 ? '▲' : '▼');
                                const markerColor = cp.delta === null ? themeColors.text : (cp.delta >= 0 ? themeColors.soc : '#b91c1c');
                                const isFirst = idx === 0;
                                const isLast = idx === socCheckpoints.length - 1;
                                const xTransform = isFirst ? 'none' : (isLast ? 'translateX(-100%)' : 'translateX(-50%)');
                                return (
                                    <div
                                        key={`${cp.timestamp}-${idx}`}
                                        className="absolute"
                                        style={{
                                            left: `${((cp.timestamp - socMinTime) / socRange) * 100}%`,
                                            top: '2px',
                                            transform: xTransform
                                        }}
                                    >
                                        <div className="flex flex-col items-center gap-0.5">
                                            <BatteryGlyph level={cp.soc} color={themeColors.soc} stroke={themeColors.axis} />
                                            <div className="text-[10px] leading-none" style={{ color: themeColors.text }}>{Math.round(cp.soc)}%</div>
                                            {marker && (
                                                <div className="text-[9px] leading-none" style={{ color: markerColor }}>{marker}</div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="18%">
                        <LineChart data={formattedData} syncId="history-power-and-soc" margin={sharedChartMargin}>
                            <defs>
                                <linearGradient id="socFillGradient" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor={themeColors.soc} stopOpacity={0.28} />
                                    <stop offset="100%" stopColor={themeColors.soc} stopOpacity={0.03} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke={themeColors.gridLines} vertical={false} />
                            <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} hide />
                            <YAxis
                                stroke={themeColors.axis}
                                domain={[0, 103]}
                                ticks={[0, 100]}
                                tickFormatter={(val) => `${val}%`}
                                width={sharedYAxisWidth}
                            />
                            <ReferenceLine
                                y={50}
                                stroke={themeColors.axis}
                                strokeDasharray="4 4"
                                strokeOpacity={0.35}
                            />
                            <Area
                                type="monotone"
                                dataKey="batterySocInterpolated"
                                stroke="none"
                                fill="url(#socFillGradient)"
                                isAnimationActive={false}
                            />
                            <Line
                                type="monotone"
                                dataKey="batterySocInterpolated"
                                name="Battery SoC (%)"
                                stroke={themeColors.soc}
                                dot={false}
                                strokeWidth={1.85}
                                connectNulls={true}
                                isAnimationActive={false}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                )}
            </div>
        </div>
    );
}
