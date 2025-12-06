'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface HourlyData {
    hour: number;
    homeUsage: number;
    solarProduction: number;
    gridUsage: number;
    batteryUsage: number;
    batterySoc: number | null;
}

interface DailyChartData {
    date: string;
    data: HourlyData[];
}

export function EnergyChartWithNav({ initialData, siteId }: { initialData: DailyChartData; siteId: string }) {
    const [chartData, setChartData] = useState(initialData);
    const [loading, setLoading] = useState(false);
    const [isDark, setIsDark] = useState(false);
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const update = () => setIsDark(mq.matches);
        update();
        mq.addEventListener('change', update);
        return () => mq.removeEventListener('change', update);
    }, []);

    const navigateDay = async (offset: number) => {
        setLoading(true);
        try {
            // Parse current date in local timezone
            const currentDate = new Date(chartData.date + 'T00:00:00');
            currentDate.setDate(currentDate.getDate() + offset);

            // Format as YYYY-MM-DD using local timezone
            const year = currentDate.getFullYear();
            const month = String(currentDate.getMonth() + 1).padStart(2, '0');
            const day = String(currentDate.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;

            const response = await fetch(`/api/hourly-data?siteId=${siteId}&date=${dateStr}`);
            if (response.ok) {
                const data = await response.json();
                setChartData(data);

                // Update URL with date query parameter
                router.push(`/site/${siteId}?date=${dateStr}`, { scroll: false });
            }
        } catch (error) {
            console.error('Failed to fetch chart data:', error);
        } finally {
            setLoading(false);
        }
    };

    const formattedData = chartData.data.map(d => ({
        hour: `${d.hour}:00`,
        'Home Usage': d.homeUsage.toFixed(2),
        'Solar Production': d.solarProduction.toFixed(2),
        'Grid Usage': d.gridUsage.toFixed(2),
        'Battery': d.batteryUsage.toFixed(2),
    }));

    // Parse date in local timezone by appending time component
    const displayDate = new Date(chartData.date + 'T00:00:00');
    const isToday = displayDate.toDateString() === new Date().toDateString();

    const palette = isDark
        ? {
            bg: 'bg-slate-900',
            text: 'text-slate-100',
            card: 'bg-slate-900',
            grid: '#334155',
            axis: '#e5e7eb',
            tooltipBg: '#0f172a',
            tooltipBorder: '#1e293b',
            tooltipText: '#e5e7eb',
        }
        : {
            bg: 'bg-white',
            text: 'text-slate-900',
            card: 'bg-white',
            grid: '#e5e7eb',
            axis: '#1f2937',
            tooltipBg: '#ffffff',
            tooltipBorder: '#e5e7eb',
            tooltipText: '#111827',
        };

    return (
        <div className={`w-full ${palette.card} p-4 rounded shadow`}>
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-semibold">Hourly Energy (kWh)</h3>
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => navigateDay(-1)}
                        disabled={loading}
                        className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300"
                    >
                        ← Previous Day
                    </button>
                    <span className="font-medium">
                        {displayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                        {isToday && ' (Today)'}
                    </span>
                    <button
                        onClick={() => navigateDay(1)}
                        disabled={loading || isToday}
                        className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300"
                    >
                        Next Day →
                    </button>
                </div>
            </div>
            <ResponsiveContainer width="100%" height={400}>
                <LineChart data={formattedData} key={chartData.date}>
                    <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
                    <XAxis dataKey="hour" tick={{ fill: palette.axis }} />
                    <YAxis tick={{ fill: palette.axis }} label={{ value: 'Energy (kWh)', angle: -90, position: 'insideLeft', fill: palette.axis }} />
                    <Tooltip
                        contentStyle={{ background: palette.tooltipBg, borderColor: palette.tooltipBorder, color: palette.tooltipText }}
                        labelStyle={{ color: palette.tooltipText }}
                        itemStyle={{ color: palette.tooltipText }}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="Solar Production" stroke="#f59e0b" strokeWidth={2} />
                    <Line type="monotone" dataKey="Home Usage" stroke="#3b82f6" strokeWidth={2} />
                    <Line type="monotone" dataKey="Grid Usage" stroke="#f97316" strokeWidth={2} />
                    <Line type="monotone" dataKey="Battery" stroke="#a855f7" strokeWidth={2} />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
