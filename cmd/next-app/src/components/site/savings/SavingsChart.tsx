'use client';

import React from 'react';
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceLine
} from 'recharts';
import type { MonthPoint } from '@/lib/roi/roi-service';

interface SavingsChartProps {
    series: MonthPoint[];
    systemCost: number;
}

const formatMonth = (monthStr: string) => {
    const [year, month] = monthStr.split('-');
    const date = new Date(Number(year), Number(month) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
};

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function SavingsChart({ series, systemCost }: SavingsChartProps) {
    if (series.length === 0) return null;

    const data = series.map(d => ({
        ...d,
        displayMonth: formatMonth(d.month),
    }));

    return (
        <div className="rounded-xl border border-gray-200 dark:border-slate-800 bg-bg-base p-5">
            <h4 className="text-xs uppercase opacity-60 mb-4 font-semibold">Cumulative Savings Curve</h4>
            <div className="h-64 w-full text-xs">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                        data={data}
                        margin={{ top: 20, right: 30, left: 0, bottom: 0 }}
                    >
                        <defs>
                            <linearGradient id="savingsColor" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="var(--theme-primary)" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="var(--theme-primary)" stopOpacity={0}/>
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-gray-100 dark:stroke-slate-800" />
                        <XAxis
                            dataKey="displayMonth"
                            tickLine={false}
                            className="fill-gray-500 dark:fill-gray-400"
                        />
                        <YAxis
                            tickFormatter={(v: number) => usd(v)}
                            tickLine={false}
                            axisLine={false}
                            className="fill-gray-500 dark:fill-gray-400"
                        />
                        <Tooltip
                            formatter={(value: unknown) => [usd(Number(value as number)), 'Saved']}
                            labelFormatter={(label) => `Month: ${label}`}
                            contentStyle={{
                                backgroundColor: 'var(--theme-bg-base)',
                                border: '1px solid var(--theme-secondary)',
                                borderRadius: '0.375rem',
                                color: 'var(--foreground)'
                            }}
                        />
                        {systemCost > 0 && (
                            <ReferenceLine
                                y={systemCost}
                                stroke="var(--theme-secondary)"
                                strokeDasharray="5 5"
                                label={{
                                    value: `Cost: ${usd(systemCost)}`,
                                    position: 'top',
                                    className: 'fill-gray-500 dark:fill-gray-400 font-medium text-[10px]'
                                }}
                            />
                        )}
                        <Area
                            type="monotone"
                            dataKey="cumulativeSaved"
                            stroke="var(--theme-primary)"
                            strokeWidth={2}
                            fillOpacity={1}
                            fill="url(#savingsColor)"
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
