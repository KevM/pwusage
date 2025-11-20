'use client';

import { useState } from 'react';
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
        'Battery SOC': d.batterySoc?.toFixed(1),
    }));

    // Parse date in local timezone by appending time component
    const displayDate = new Date(chartData.date + 'T00:00:00');
    const isToday = displayDate.toDateString() === new Date().toDateString();

    return (
        <div className="w-full bg-white p-4 rounded shadow">
            <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-semibold">Hourly Energy (kWh) & Battery SOC (%)</h3>
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
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hour" />
                    <YAxis yAxisId="left" label={{ value: 'Energy (kWh)', angle: -90, position: 'insideLeft' }} />
                    <YAxis yAxisId="right" orientation="right" label={{ value: 'SOC (%)', angle: 90, position: 'insideRight' }} />
                    <Tooltip />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="Solar Production" stroke="#f59e0b" strokeWidth={2} />
                    <Line yAxisId="left" type="monotone" dataKey="Home Usage" stroke="#3b82f6" strokeWidth={2} />
                    <Line yAxisId="left" type="monotone" dataKey="Grid Usage" stroke="#f97316" strokeWidth={2} />
                    <Line yAxisId="left" type="monotone" dataKey="Battery" stroke="#a855f7" strokeWidth={2} />
                    <Line yAxisId="right" type="monotone" dataKey="Battery SOC" stroke="#d946ef" strokeWidth={3} strokeDasharray="5 5" />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
