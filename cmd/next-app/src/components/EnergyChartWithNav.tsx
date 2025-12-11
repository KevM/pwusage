'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
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

    const dateInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const update = () => setIsDark(mq.matches);
        update();
        mq.addEventListener('change', update);
        return () => mq.removeEventListener('change', update);
    }, []);

    useEffect(() => {
        setChartData(initialData);
    }, [initialData]);

    const fetchAndSetData = async (dateStr: string) => {
        setLoading(true);
        try {
            const response = await fetch(`/api/hourly-data?siteId=${siteId}&date=${dateStr}`);
            if (response.ok) {
                const data = await response.json();
                setChartData(data);
                router.push(`/site/${siteId}?date=${dateStr}`, { scroll: false });
            }
        } catch (error) {
            console.error('Failed to fetch chart data:', error);
        } finally {
            setLoading(false);
        }
    };

    const navigateDay = async (offset: number) => {
        // Parse current date in local timezone
        const currentDate = new Date(chartData.date + 'T00:00:00');
        currentDate.setDate(currentDate.getDate() + offset);

        // Format as YYYY-MM-DD using local timezone
        const year = currentDate.getFullYear();
        const month = String(currentDate.getMonth() + 1).padStart(2, '0');
        const day = String(currentDate.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        await fetchAndSetData(dateStr);
    };

    const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.value) {
            fetchAndSetData(e.target.value);
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
            <div className="flex flex-wrap justify-between items-center mb-4 gap-4">
                <h3 className="text-xl font-semibold text-left">Hourly Energy (kWh)</h3>

                <div className="flex bg-white dark:bg-slate-900 rounded-lg p-1 shadow-sm border border-slate-200 dark:border-slate-800 items-center justify-between gap-1 shrink-0">
                    <button
                        onClick={() => navigateDay(-1)}
                        disabled={loading}
                        className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-none"
                        title="Previous Day"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m15 18-6-6 6-6" />
                        </svg>
                    </button>

                    <div className="relative group flex-1 md:flex-none text-center min-w-[140px]">
                        <div
                            className="font-semibold text-sm hover:underline decoration-blue-500 decoration-2 underline-offset-4 cursor-pointer rounded px-2 py-1 transition-colors w-full h-full flex items-center justify-center"
                            title="Click to pick a date"
                        >
                            {displayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                            {isToday && ' (Today)'}
                        </div>
                        <input
                            ref={dateInputRef}
                            type="date"
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                            onChange={handleDateChange}
                            onClick={() => {
                                try {
                                    dateInputRef.current?.showPicker();
                                } catch {
                                    // Fallback for browsers that don't support showPicker (though most modern ones do)
                                    // The input itself is clicked, so the native picker should trigger anyway.
                                }
                            }}
                            max={new Date().toISOString().split('T')[0]} // Prevent future dates
                        />
                    </div>

                    <button
                        onClick={() => navigateDay(1)}
                        disabled={loading || isToday}
                        className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-none"
                        title="Next Day"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m9 18 6-6-6-6" />
                        </svg>
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
