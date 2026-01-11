
'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import NILMChart from '@/components/NILMChart';
import { PowerData } from '@/lib/nilm/types';
import { LoadEvent } from '@/lib/nilm/load-detection';
import Link from 'next/link';

import TagModal from '@/components/TagModal';

export default function NILMPage() {
    const params = useParams(); // { id: string }
    const siteId = params?.id as string;

    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<PowerData[]>([]);
    const [events, setEvents] = useState<(LoadEvent & { tags?: string[] })[]>([]);
    const [tariffMap, setTariffMap] = useState<Record<number, string>>({});

    const [taggingEvent, setTaggingEvent] = useState<(LoadEvent & { tags?: string[] }) | null>(null);
    const [hoveredEvent, setHoveredEvent] = useState<LoadEvent | null>(null);
    const [selectedEvent, setSelectedEvent] = useState<LoadEvent | null>(null);

    // Default tags requested by user
    const [availableTags, setAvailableTags] = useState<string[]>([
        'EV', 'Oven', 'Dryer', 'HVAC', 'Microwave'
    ]);

    const handleEventClick = (ev: LoadEvent) => {
        if (selectedEvent === ev) {
            setSelectedEvent(null);
        } else {
            setSelectedEvent(ev);
        }
    };

    const fetchData = React.useCallback(async () => {
        if (!siteId) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/site/${siteId}/nilm?date=${date}`);
            if (!res.ok) throw new Error('Failed to fetch data');
            const json = await res.json();
            setData(json.data);
            setEvents(json.events || []);
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

    const handleAddTag = async (tag: string) => {
        if (!taggingEvent) return;

        // Add to available tags if new
        if (!availableTags.includes(tag)) {
            setAvailableTags(prev => [...prev, tag]);
        }

        try {
            await fetch(`/api/site/${siteId}/nilm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'add_tag',
                    start_time: taggingEvent.startTime,
                    end_time: taggingEvent.endTime,
                    tag
                })
            });
            fetchData(); // Refresh to see tags
        } catch (e) {
            console.error(e);
        }
    };

    const handleRemoveTag = async (e: React.MouseEvent, event: LoadEvent, tag: string) => {
        e.stopPropagation();
        if (!confirm(`Remove tag "${tag}"?`)) return;
        try {
            await fetch(`/api/site/${siteId}/nilm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'remove_tag',
                    start_time: event.startTime,
                    end_time: event.endTime,
                    tag
                })
            });
            fetchData();
        } catch (e) {
            console.error(e);
        }
    };

    // Formatting Helpers
    const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formatDuration = (minutes: number) => {
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    };

    // Date Navigation Helpers
    const changeDate = (days: number) => {
        const d = new Date(date + 'T00:00:00');
        d.setDate(d.getDate() + days);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        setDate(`${y}-${m}-${day}`);
    };

    return (
        <div className="min-h-screen bg-gray-950 text-gray-100 p-6 font-sans">
            <TagModal
                isOpen={!!taggingEvent}
                onClose={() => setTaggingEvent(null)}
                onSave={handleAddTag}
                currentTags={taggingEvent?.tags}
                availableTags={availableTags}
            />

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
                    <NILMChart
                        data={data}
                        events={events}
                        tariffs={tariffMap}
                        highlightedEvent={hoveredEvent}
                        selectedEvent={selectedEvent}
                        onEventClick={handleEventClick}
                    />
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
                                <th className="px-6 py-3">Tags & Annotations</th>
                                <th className="px-6 py-3 text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {events.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="px-6 py-8 text-center text-gray-500 italic">
                                        No significant load events detected for this day.
                                    </td>
                                </tr>
                            ) : (
                                events.map((ev, i) => {
                                    const isSelected = selectedEvent === ev;
                                    const isHovered = hoveredEvent === ev;

                                    // Row Style Logic
                                    // Base + Selection/Hover States
                                    let rowClass = "transition-colors cursor-pointer border-l-4 ";
                                    if (isSelected) {
                                        rowClass += "bg-gray-800 border-cyan-400 ";
                                    } else if (isHovered) {
                                        rowClass += "bg-gray-800/50 border-gray-700 ";
                                    } else {
                                        rowClass += "hover:bg-gray-800/30 border-transparent ";
                                    }

                                    return (
                                        <tr
                                            key={i}
                                            className={rowClass}
                                            onMouseEnter={() => setHoveredEvent(ev)}
                                            onMouseLeave={() => setHoveredEvent(null)}
                                            onClick={() => handleEventClick(ev)}
                                        >
                                            <td className="px-6 py-4 font-medium text-white">{i + 1}</td>
                                            <td className="px-6 py-4 text-cyan-300">{formatTime(ev.startTime.toString())}</td>
                                            <td className="px-6 py-4">{formatTime(ev.endTime.toString())}</td>
                                            <td className="px-6 py-4 text-right">{formatDuration(ev.durationMinutes)}</td>
                                            <td className="px-6 py-4 text-right font-medium">{(ev.averagePower / 1000).toFixed(2)} kW</td>
                                            <td className="px-6 py-4 text-right text-amber-400">{(ev.maxPower / 1000).toFixed(2)} kW</td>
                                            <td className="px-6 py-4 text-right text-green-400">{ev.kwh} kWh</td>
                                            <td className="px-6 py-4">
                                                <div className="flex flex-wrap gap-2">
                                                    {ev.tags?.map(tag => (
                                                        <span key={tag} className={`px-2 py-0.5 rounded textxs border flex items-center gap-1
                                                        ${tag === 'Arbitrage Candidate'
                                                                ? 'bg-red-900/30 border-red-800 text-red-300'
                                                                : 'bg-blue-900/30 border-blue-800 text-blue-300'
                                                            }`}>
                                                            {tag}
                                                            {tag !== 'Arbitrage Candidate' && (
                                                                <button
                                                                    onClick={(e) => handleRemoveTag(e, ev, tag)}
                                                                    className="hover:text-white"
                                                                >
                                                                    &times;
                                                                </button>
                                                            )}
                                                        </span>
                                                    ))}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                <button
                                                    onClick={() => setTaggingEvent(ev)}
                                                    className="bg-gray-700 text-white text-xs px-2 py-1 rounded inline-block whitespace-nowrap"
                                                    title="Tag Event"
                                                >
                                                    ✏️ Tag
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })
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
