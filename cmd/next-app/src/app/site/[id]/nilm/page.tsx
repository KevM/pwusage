
'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import NILMChart from '@/components/NILMChart';
import { PowerData } from '@/lib/nilm/types';
import { LoadEvent } from '@/lib/nilm/load-detection';
import Link from 'next/link';

export default function NILMPage() {
    const params = useParams(); // { id: string }
    const siteId = params?.id as string;

    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<PowerData[]>([]);
    const [events, setEvents] = useState<LoadEvent[]>([]);
    const [tariffMap, setTariffMap] = useState<Record<number, string>>({});

    const fetchData = React.useCallback(async () => {
        if (!siteId) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/site/${siteId}/nilm?date=${date}`);
            if (!res.ok) throw new Error('Failed to fetch data');
            const json = await res.json();
            setData(json.data);
            setEvents(json.events);
            setTariffMap(json.tariffs || {});
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    }, [siteId, date]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    // Formatting Helpers
    const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Date Navigation Helpers
    const changeDate = (days: number) => {
        const d = new Date(date + 'T00:00:00'); // Force local time interpretation
        d.setDate(d.getDate() + days);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        setDate(`${y}-${m}-${day}`);
    };

    return (
        <div className="min-h-screen bg-gray-950 text-gray-100 p-6 font-sans">
            {/* Header */}
            <div className="mb-6 flex justify-between items-center">
                <div>
                    <Link href={`/site/${siteId}`} className="text-gray-400 hover:text-white text-sm mb-1 inline-block">
                        &larr; Back to Dashboard
                    </Link>
                    <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500">
                        NILM High-Fidelity Analysis
                    </h1>
                </div>

                <div className="flex gap-2 items-center">
                    <button
                        onClick={() => changeDate(-1)}
                        className="bg-gray-800 hover:bg-gray-700 text-white px-3 py-2 rounded-lg transition-colors border border-gray-700"
                        title="Previous Day"
                    >
                        &larr;
                    </button>

                    <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        className="bg-gray-800 border border-gray-700 text-white px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />

                    <button
                        onClick={() => changeDate(1)}
                        className="bg-gray-800 hover:bg-gray-700 text-white px-3 py-2 rounded-lg transition-colors border border-gray-700"
                        title="Next Day"
                    >
                        &rarr;
                    </button>

                    <button
                        onClick={fetchData}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors ml-2"
                    >
                        Refresh
                    </button>
                </div>
            </div>

            {/* Chart Section */}
            <div className="mb-8">
                {loading ? (
                    <div className="h-[500px] w-full flex items-center justify-center bg-gray-900/50 rounded-xl border border-gray-800">
                        <span className="text-gray-400 animate-pulse">Loading High-Fidelity Data...</span>
                    </div>
                ) : (
                    <NILMChart data={data} events={events} tariffs={tariffMap} />
                )}
            </div>

            {/* Event Table */}
            <div className="bg-gray-900/50 border border-gray-800 rounded-xl overflow-hidden">
                <div className="p-4 border-b border-gray-800 bg-gray-900">
                    <h3 className="font-semibold text-lg text-gray-200">Detected Load Events</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-gray-400">
                        <thead className="bg-gray-800/50 text-gray-300 uppercase tracking-wider text-xs font-medium">
                            <tr>
                                <th className="px-6 py-3">#</th>
                                <th className="px-6 py-3">Start Time</th>
                                <th className="px-6 py-3">End Time</th>
                                <th className="px-6 py-3 text-right">Duration</th>
                                <th className="px-6 py-3 text-right">Avg Power</th>
                                <th className="px-6 py-3 text-right">Max Power</th>
                                <th className="px-6 py-3 text-right">Energy</th>
                                <th className="px-6 py-3 text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {events.length === 0 ? (
                                <tr>
                                    <td colSpan={8} className="px-6 py-8 text-center text-gray-500 italic">
                                        No significant load events detected for this day.
                                    </td>
                                </tr>
                            ) : (
                                events.map((ev, i) => (
                                    <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                                        <td className="px-6 py-4 font-medium text-white">{i + 1}</td>
                                        <td className="px-6 py-4 text-cyan-300">{formatTime(ev.startTime.toString())}</td>
                                        <td className="px-6 py-4">{formatTime(ev.endTime.toString())}</td>
                                        <td className="px-6 py-4 text-right">{ev.durationMinutes} m</td>
                                        <td className="px-6 py-4 text-right font-medium">{Math.round(ev.averagePower)} W</td>
                                        <td className="px-6 py-4 text-right text-amber-400">{ev.maxPower} W</td>
                                        <td className="px-6 py-4 text-right text-green-400">{ev.kwh} kWh</td>
                                        <td className="px-6 py-4 text-center">
                                            <button className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded">
                                                Tag
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="mt-8 p-4 bg-gray-900/30 rounded-lg text-xs text-gray-500">
                <p>NILM Algorithm: Sliding Window Gradient (15m window) + Baseline Return Closure. Source: Total Home Load.</p>
            </div>
        </div>
    );
}
