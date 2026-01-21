'use client';

import React from 'react';
import {
    LineChart,
    Line,
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

interface NILMChartProps {
    data: PowerData[];
    events: LoadEvent[];
    tariffs?: Record<number, string>;
    highlightedEvent?: LoadEvent | null;
    selectedEvent?: LoadEvent | null;
    onEventClick?: (event: LoadEvent) => void;
    isDarkMode?: boolean;
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
    line: string;
    cursor: string;
    text: string;
    solar: string;
    battery: string;
    load: string;
    gridTrace: string;
}

interface TooltipProps {
    active?: boolean;
    payload?: { value: number | string; payload: PowerData & { touName?: string; tariffId?: number } }[];
    label?: string | number;
    events?: (LoadEvent & { index: number; startMs: number; endMs: number })[];
    tariffs?: Record<number, string>;
    isDarkMode?: boolean;

    themeColors?: ThemeColors;
}

const TooltipContent = ({ active, payload, label, events, tariffs, isDarkMode, themeColors }: TooltipProps) => {
    if (active && payload && payload.length) {
        const time = new Date(Number(label)).getTime();
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

        // STYLING NOTE: Using inline styles for background AND TEXT to force compliance on Safari
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
                        <p style={{ color: colors.subText, fontWeight: 500 }}>{new Date(Number(label)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                        <p style={{ color: colors.dateText, fontSize: '10px' }}>{new Date(Number(label)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</p>
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

const CustomTick = ({ x, y, payload, xAxisConfig, themeColors }: CustomTickProps) => {
    if (!payload || x === undefined || y === undefined) return null;
    const time = payload.value;
    const date = new Date(time);
    const isTransition = xAxisConfig.transitionTimes.has(time);
    const hour = date.getHours();
    const minute = date.getMinutes();
    const isWholeHour = minute === 0;
    const isMajorHour = isWholeHour && (hour % 4 === 0);

    const isMajor = isTransition || isMajorHour;
    const isMinor = isWholeHour && !isMajor;

    const lineHeight = isMajor ? 10 : 5;
    const lineOpacity = isMajor ? 0.6 : 0.2;

    let label = null;

    if (isTransition) {
        label = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '');
    } else if (isMajorHour) {
        label = date.toLocaleTimeString([], { hour: 'numeric' }).toLowerCase().replace(' ', '');
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

export default function NILMChart({ data, events, tariffs, highlightedEvent, selectedEvent, onEventClick, isDarkMode = true }: NILMChartProps) {
    const [hoverTime, setHoverTime] = React.useState<number | null>(null);
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

    // Theme Colors
    const themeColors = React.useMemo(() => ({
        gridLines: isDarkMode ? "#374151" : "#e5e7eb",
        axis: isDarkMode ? "#9CA3AF" : "#6B7280",
        line: isDarkMode ? "#22d3ee" : "#0891b2", // Cyan-400 vs Cyan-600
        cursor: isDarkMode ? "#6B7280" : "#9CA3AF",
        text: isDarkMode ? "#9CA3AF" : "#6B7280",
        solar: isDarkMode ? "#fbbf24" : "#f59e0b",
        battery: isDarkMode ? "#4ade80" : "#10b981",
        load: isDarkMode ? "#c084fc" : "#9333ea", // Purple-400 / Purple-600
        gridTrace: isDarkMode ? "#A67B5B" : "#6F4E37"  // Cocoa Brown (Dark/Light)
    }), [isDarkMode]);

    // Pre-process events for performance
    const processedEvents = React.useMemo(() => {
        return events.map((e, index) => ({
            ...e,
            index,
            startMs: parseDate(e.startTime).getTime(),
            endMs: parseDate(e.endTime).getTime()
        }));
    }, [events]);

    const formattedData = React.useMemo(() => data.map(d => ({
        ...d,
        time: parseDate(d.timestamp).getTime(),
        datetime: parseDate(d.timestamp).toLocaleString(),
    })), [data]);

    // ... tariffRegions and xAxisConfig logic unchanged ...

    // Calculate Tariff Regions
    const tariffRegions = React.useMemo(() => {
        if (!formattedData.length) return [];
        const regions: { start: number, end: number, name: string }[] = [];

        let currentStart = formattedData[0].time;
        // Prefer touName (calculated by server), then fall back to tariffId lookup
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
                // Start new region
                currentStart = point.time;
                currentName = pointExample;
            }
        }
        // Push last region
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

        // 1. Add Tariff Transitions
        tariffRegions.forEach(r => {
            ticks.add(r.start);
            transitionTimes.add(r.start);
            // We usually don't label 'end' of last region if it's just end of data
        });

        // 2. Add Whole Hours
        const startDate = new Date(start);
        startDate.setMinutes(0, 0, 0);
        // If start was past the hour, move to next hour
        if (startDate.getTime() < start) startDate.setHours(startDate.getHours() + 1);

        let current = startDate.getTime();
        while (current <= end) {
            ticks.add(current);
            current += 3600 * 1000;
        }

        return {
            ticks: Array.from(ticks).sort((a, b) => a - b),
            transitionTimes
        };
    }, [formattedData, tariffRegions]);




    if (!data || data.length === 0) {
        return (
            <div className={`w-full h-[500px] flex items-center justify-center rounded-xl border ${isDarkMode ? 'bg-gray-900/50 border-gray-800 text-gray-500' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
                No graph data available to display.
            </div>
        );
    }

    return (
        <div className={`p-4 rounded-xl border outline-none ring-0 focus:outline-none ${isDarkMode ? 'bg-gray-900/50 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            {/* Custom Legend / Toggles */}
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

            <div style={{ width: '100%', height: 460 }}>
                <style>{`
                .recharts-wrapper, .recharts-surface, .recharts-layer {
                    outline: none !important;
                }
            `}</style>
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                        data={formattedData}
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
                            tick={<CustomTick xAxisConfig={xAxisConfig} themeColors={themeColors} />}
                            interval={0} // Force render all custom ticks
                            stroke={themeColors.axis}
                            height={40}
                        />
                        <YAxis
                            stroke={themeColors.axis}
                            tickFormatter={(val) => `${(val / 1000).toFixed(1)} kW`}
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
                            content={<TooltipContent events={processedEvents} tariffs={tariffs} isDarkMode={isDarkMode} themeColors={themeColors} />}
                            cursor={{ stroke: themeColors.cursor, strokeWidth: 1, strokeDasharray: '3 3' }}
                            wrapperStyle={{ outline: 'none' }}
                        />
                        {/* Hiding default Legend since we have custom controls */}
                        {/* <Legend /> */}

                        <Line
                            type="linear"
                            dataKey="powerWatts"
                            name="Load Power (kW)"
                            stroke={themeColors.load} // Purple
                            dot={false}
                            strokeWidth={2}
                            animationDuration={500}
                            hide={!visibleSeries.load}
                            isAnimationActive={false} // Disable animation for improved responsiveness
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
            </div>
        </div>
    );
}
