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
    ReferenceArea
} from 'recharts';
import { PowerData } from '@/lib/nilm/types';
import { LoadEvent } from '@/lib/nilm/load-detection';

interface NILMChartProps {
    data: PowerData[];
    events: LoadEvent[];
    tariffs?: Record<number, string>;
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
                        <p style={{ color: '#9ca3af', fontSize: '10px' }}>{new Date(label!).toLocaleDateString()}</p>
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
                    </div>
                )}
            </div>
        );
    }
    return null;
};

export default function NILMChart({ data, events, tariffs }: NILMChartProps) {
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
            const lastName = formattedData[formattedData.length - 1].touName || (formattedData[formattedData.length - 1].tariffId ? tariffs?.[formattedData[formattedData.length - 1].tariffId] : 'Unknown');
            regions.push({
                start: currentStart,
                end: formattedData[formattedData.length - 1].time,
                name: lastName || 'Unknown'
            });
        }
        return regions;
    }, [formattedData, tariffs]);

    const formatXAxis = (tick: number) => {
        return new Date(tick).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    if (!data || data.length === 0) {
        return (
            <div className="w-full h-[500px] flex items-center justify-center bg-gray-900/50 rounded-xl border border-gray-800 text-gray-500">
                No graph data available to display.
            </div>
        );
    }

    return (
        <div style={{ width: '100%', height: 500 }} className="bg-gray-900/50 p-4 rounded-xl border border-gray-800">
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
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis
                        dataKey="time"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={formatXAxis}
                        stroke="#9CA3AF"
                        minTickGap={50}
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

                    {/* Explicit Vertical Transition Lines - Neutral Gray */}
                    {tariffRegions.map((region, i) => {
                        if (i === 0) return null;
                        return (
                            <ReferenceArea
                                key={`trans-line-${i}`}
                                x1={region.start}
                                x2={region.start}
                                stroke="#6B7280" // Gray-500
                                strokeWidth={1}
                                strokeDasharray="3 3"
                                strokeOpacity={1}
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
                        const isHovered = hoverTime && hoverTime >= event.startMs && hoverTime <= event.endMs;
                        return (
                            <ReferenceArea
                                key={index}
                                x1={event.startMs}
                                x2={event.endMs}
                                stroke={isHovered ? "#fff" : "transparent"}
                                strokeOpacity={0.8}
                                fill="#a855f7" // Purple-500
                                fillOpacity={isHovered ? 0.5 : 0.25} // Increased opacity for pop vs background
                                label={{
                                    value: "Load",
                                    position: 'insideBottom',
                                    fill: '#c084fc', // Purple-400 text
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
