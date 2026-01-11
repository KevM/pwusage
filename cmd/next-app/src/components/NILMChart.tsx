'use client';

import React from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
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

const TooltipContent = ({ active, payload, label, events, tariffs }: { active?: boolean; payload?: { value: number | string, payload?: any }[]; label?: string | number, events?: any[], tariffs?: Record<number, string> }) => {
    if (active && payload && payload.length) {
        const time = new Date(label!).getTime();
        const dataPoint = payload[0].payload;

        // Use pre-calculated touName from backend if available, otherwise fallback
        const touName = dataPoint.touName;
        const tariffId = dataPoint.tariffId;

        const rawName = touName || (
            (tariffs && tariffId !== undefined)
                ? (tariffs[tariffId] || tariffs[String(tariffId) as any] || `Tariff ${tariffId}`)
                : undefined
        );

        const displayName = formatTariffName(rawName);
        const isPeak = displayName?.toLowerCase().includes('peak') && !displayName?.toLowerCase().includes('off');

        // Find active event
        const activeEvent = events?.find(e => time >= e.startMs && time <= e.endMs);

        // STYLING NOTE: Using inline styles for background AND TEXT to force compliance on Safari
        return (
            <div
                className="rounded-xl shadow-2xl z-50 min-w-[200px]"
                style={{
                    backgroundColor: 'rgba(17, 24, 39, 1)', // Solid Dark Gray (Tailwind gray-900)
                    border: '1px solid #374151',           // Tailwind gray-700
                    padding: '12px',
                    color: '#f3f4f6'                       // Force White Text
                }}
            >
                <div className="flex justify-between items-start mb-3 border-b border-gray-700 pb-2">
                    <div>
                        <p style={{ color: '#d1d5db', fontWeight: 500 }}>{new Date(label!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                        <p style={{ color: '#9ca3af', fontSize: '10px' }}>{new Date(label!).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</p>
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

                <div className="flex items-center justify-between gap-4 mb-2">
                    <span style={{ color: '#9ca3af' }}>Power</span>
                    <span style={{ color: '#22d3ee', fontWeight: 'bold', fontSize: '16px' }}>{(Number(payload[0].value) / 1000).toFixed(2)} <span style={{ fontSize: '12px', fontWeight: 'normal', color: '#22d3ee' }}>kW</span></span>
                </div>

                {activeEvent && (
                    <div className="mt-3 pt-3 border-t border-gray-700 -mx-4 px-4 pb-1" style={{ backgroundColor: 'rgba(147, 51, 234, 0.1)' }}>
                        <div className="flex justify-between items-center mb-2">
                            <span style={{ color: '#c084fc', fontWeight: 'bold' }}>Load #{activeEvent.index + 1}</span>
                            <span style={{ fontSize: '10px', color: 'rgba(192, 132, 252, 0.7)', borderColor: 'rgba(192, 132, 252, 0.3)', borderWidth: '1px', padding: '0 4px', borderRadius: '4px' }}>DETECTED LOAD</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1" style={{ color: '#9ca3af' }}>
                            <span>Duration</span> <span style={{ color: '#e5e7eb', textAlign: 'right' }}>{activeEvent.durationMinutes}m</span>
                            <span>Energy</span> <span style={{ color: '#4ade80', textAlign: 'right' }}>{activeEvent.kwh} kWh</span>
                            <span>Avg Pwr</span> <span style={{ color: '#e5e7eb', textAlign: 'right' }}>{(activeEvent.averagePower / 1000).toFixed(1)} kW</span>
                        </div>

                        {activeEvent.tags && activeEvent.tags.length > 0 && (
                            <div className="mt-3 text-xs flex flex-wrap gap-1">
                                {activeEvent.tags.map((tag: string) => (
                                    <span key={tag} className="px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-200 border border-blue-800">
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

export default function NILMChart({ data, events, tariffs, highlightedEvent, selectedEvent, onEventClick }: NILMChartProps) {
    const [hoverTime, setHoverTime] = React.useState<number | null>(null);

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

    // Custom Tick Component
    const CustomTick = (props: any) => {
        const { x, y, mapPayload, payload, index } = props;
        const time = payload.value;
        const date = new Date(time);
        const isTransition = xAxisConfig.transitionTimes.has(time);
        const hour = date.getHours();
        const minute = date.getMinutes();
        const isWholeHour = minute === 0;
        const isMajorHour = isWholeHour && (hour % 4 === 0); // 12am, 4am, 8am...

        // Determine Tick Style
        const isMajor = isTransition || isMajorHour;
        const isMinor = isWholeHour && !isMajor;

        // Label Logic: Show if Transition OR (Major Hour AND not close to transition)
        // Simple heuristic: Show labels for Transitions and Major Hours. 
        // Recharts handles overlap if we let it, but we want to force specific ones.
        // Let's rely on visual hierarchy.

        // Tick Line
        const lineY = y;
        const lineHeight = isMajor ? 10 : 5;
        const lineOpacity = isMajor ? 0.6 : 0.2;

        let label = null;

        if (isTransition) {
            label = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '');
        } else if (isMajorHour) {
            label = date.toLocaleTimeString([], { hour: 'numeric' }).toLowerCase().replace(' ', ''); // 4am
        }

        // Avoid labeling major hour if it's very close to a transition? 
        // For now, let's render all and let user judge.

        if (!isMajor && !isMinor) return null; // Shouldn't happen given our ticks gen

        return (
            <g transform={`translate(${x},${y})`}>
                <line x1={0} y1={0} x2={0} y2={lineHeight} stroke="#9CA3AF" strokeOpacity={lineOpacity} />
                {label && (
                    <text
                        x={0}
                        y={lineHeight + 12}
                        textAnchor="middle"
                        fill="#9CA3AF"
                        fontSize={10}
                        fontWeight={isTransition ? "bold" : "normal"}
                    >
                        {label}
                    </text>
                )}
            </g>
        );
    };

    if (!data || data.length === 0) {
        return (
            <div className="w-full h-[500px] flex items-center justify-center bg-gray-900/50 rounded-xl border border-gray-800 text-gray-500">
                No graph data available to display.
            </div>
        );
    }

    return (
        <div style={{ width: '100%', height: 500 }} className="bg-gray-900/50 p-4 rounded-xl border border-gray-800 outline-none ring-0 focus:outline-none">
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
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                    <XAxis
                        dataKey="time"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        ticks={xAxisConfig.ticks}
                        tick={<CustomTick />}
                        interval={0} // Force render all custom ticks
                        stroke="#9CA3AF"
                        height={40}
                    />
                    <YAxis
                        stroke="#9CA3AF"
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
                                stroke="#9CA3AF"
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
                        const labelColor = isPeak ? '#f87171' : (isOffPeak ? '#34d399' : '#9ca3af');

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
                                    fill: active ? '#fdf2f8' : '#c084fc',
                                    fontSize: 12,
                                    fontWeight: 'bold',
                                    offset: 5
                                }}
                            />
                        );
                    })}

                    <Tooltip
                        content={<TooltipContent events={processedEvents} tariffs={tariffs} />}
                        cursor={{ stroke: '#6B7280', strokeWidth: 1, strokeDasharray: '3 3' }}
                        wrapperStyle={{ outline: 'none' }}
                    />
                    <Legend />

                    <Line
                        type="linear"
                        dataKey="powerWatts"
                        name="Load Power (kW)"
                        stroke="#22d3ee" // Cyan
                        dot={false}
                        strokeWidth={2}
                        animationDuration={500}
                        isAnimationActive={false} // Disable animation for improved responsiveness
                    />

                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
