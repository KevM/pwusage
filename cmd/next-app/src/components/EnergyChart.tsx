'use client';

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface HourlyData {
    hour: number;
    homeUsage: number;
    solarProduction: number;
    gridUsage: number;
    batteryUsage: number;
    batterySoc: number | null;
}

export function EnergyChart({ data }: { data: HourlyData[] }) {
    const chartData = data.map(d => ({
        hour: `${d.hour}:00`,
        'Home Usage': d.homeUsage.toFixed(2),
        'Solar Production': d.solarProduction.toFixed(2),
        'Grid Usage': d.gridUsage.toFixed(2),
        'Battery': d.batteryUsage.toFixed(2),
        'Battery SOC': d.batterySoc?.toFixed(1),
    }));

    return (
        <div className="w-full bg-white p-4 rounded shadow">
            <h3 className="text-xl font-semibold mb-4">Today's Hourly Energy (kWh) & Battery SOC (%)</h3>
            <ResponsiveContainer width="100%" height={400}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hour" />
                    <YAxis yAxisId="left" label={{ value: 'Energy (kWh)', angle: -90, position: 'insideLeft' }} />
                    <YAxis yAxisId="right" orientation="right" label={{ value: 'SOC (%)', angle: 90, position: 'insideRight' }} />
                    <Tooltip />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="Home Usage" stroke="#8884d8" strokeWidth={2} />
                    <Line yAxisId="left" type="monotone" dataKey="Solar Production" stroke="#82ca9d" strokeWidth={2} />
                    <Line yAxisId="left" type="monotone" dataKey="Grid Usage" stroke="#ff7300" strokeWidth={2} />
                    <Line yAxisId="left" type="monotone" dataKey="Battery" stroke="#ffc658" strokeWidth={2} />
                    <Line yAxisId="right" type="monotone" dataKey="Battery SOC" stroke="#d946ef" strokeWidth={3} strokeDasharray="5 5" />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
