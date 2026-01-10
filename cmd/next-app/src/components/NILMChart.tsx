
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
}

// Helper to safely parse dates
const parseDate = (val: string | Date | number) => {
    if (typeof val === 'number') return new Date(val);
    if (val instanceof Date) return val;
    return new Date(String(val).replace(' ', 'T'));
};

const TooltipContent = ({ active, payload, label, events }: { active?: boolean; payload?: { value: number | string }[]; label?: string | number, events?: any[] }) => {
    if (active && payload && payload.length) {
        const time = new Date(label!).getTime();
        // Find active event
        const activeEvent = events?.find(e => time >= e.startMs && time <= e.endMs);

        return (
            <div className="bg-gray-900/90 backdrop-blur-sm p-3 border border-gray-700/50 rounded-xl shadow-2xl text-xs text-gray-100 z-50">
                <p className="text-gray-400 mb-1">{new Date(label!).toLocaleString()}</p>
                <div className="flex items-center justify-between gap-4">
                    <span className="text-gray-300">Power:</span>
                    <span className="text-cyan-400 font-bold text-sm">{(Number(payload[0].value) / 1000).toFixed(2)} kW</span>
                </div>

                {activeEvent && (
                    <div className="mt-2 pt-2 border-t border-gray-700/50">
                        <p className="text-amber-400 font-bold mb-1">Event #{activeEvent.index + 1}</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-400">
                            <span>Duration:</span> <span className="text-gray-200 text-right">{activeEvent.durationMinutes}m</span>
                            <span>Energy:</span> <span className="text-green-400 text-right">{activeEvent.kwh} kWh</span>
                            <span>Avg Pwr:</span> <span className="text-gray-200 text-right">{(activeEvent.averagePower / 1000).toFixed(1)} kW</span>
                        </div>
                    </div>
                )}
            </div>
        );
    }
    return null;
};

export default function NILMChart({ data, events }: NILMChartProps) {
    const [hoverTime, setHoverTime] = React.useState<number | null>(null);

    // Pre-process events for performance and easier lookups
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
                    <Tooltip content={<TooltipContent events={processedEvents} />} />
                    <Legend />

                    <Line
                        type="monotone"
                        dataKey="powerWatts"
                        name="Load Power (kW)"
                        stroke="#22d3ee" // Cyan
                        dot={false}
                        strokeWidth={2}
                        animationDuration={500}
                    />

                    {/* Render Event Overlays */}
                    {processedEvents.map((event, index) => {
                        const isHovered = hoverTime && hoverTime >= event.startMs && hoverTime <= event.endMs;

                        return (
                            <ReferenceArea
                                key={index}
                                x1={event.startMs}
                                x2={event.endMs}
                                stroke={isHovered ? "#fff" : "transparent"}
                                strokeOpacity={0.5}
                                fill="#f59e0b" // Amber
                                fillOpacity={isHovered ? 0.3 : 0.15}
                                label={{
                                    value: `Event #${index + 1} (${(event.averagePower / 1000).toFixed(1)}kW)`,
                                    position: 'insideTopLeft',
                                    fill: isHovered ? '#fff' : '#f59e0b',
                                    fontSize: 10
                                }}
                            />
                        );
                    })}

                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
