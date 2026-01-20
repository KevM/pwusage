'use client';

import React, { useState, useEffect } from 'react';
import NILMChart from '@/components/NILMChart';
import { PowerData } from '@/lib/nilm/types';
import { LoadEvent } from '@/lib/nilm/load-detection';
import { Breadcrumbs } from './Breadcrumbs';
import { useSearchParams } from 'next/navigation';

import TagModal from '@/components/TagModal';

interface LoadAnalysisClientPageProps {
    siteId: string;
    siteName: string;
}

export default function LoadAnalysisClientPage({ siteId, siteName }: LoadAnalysisClientPageProps) {
    const searchParams = useSearchParams();
    const initialDate = searchParams.get('date') || new Date().toISOString().split('T')[0];

    // Initialize date from URL or Today
    const [date, setDate] = useState<string>(initialDate);

    // Update date if URL changes? 
    // Usually standard pattern is: URL drives state. 
    // But here we want local state to drive URL or just sync?
    // Let's stick to local state initialized from URL for now. 
    // Changing date using `setDate` won't update URL unless we push router.
    // For now, let's just initialize. The user can refresh or click "Back" to reset.
    // Or we should update URL on change? 
    // The requirement was: "Analysis button next to the date selection...". 
    // If I select a date there and click Analysis, it opens this page with that date. 
    // That's satisfied by initialization.

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

    const dateInputRef = React.useRef<HTMLInputElement>(null);
    const displayDate = new Date(date + 'T00:00:00');
    const isToday = displayDate.toDateString() === new Date().toDateString();

    // Theme Detection Hook
    const useThemeDetector = () => {
        const getCurrentTheme = () => typeof window !== 'undefined' ? window.matchMedia("(prefers-color-scheme: dark)").matches : false;
        const [isDarkTheme, setIsDarkTheme] = useState(getCurrentTheme());

        useEffect(() => {
            const darkThemeMq = window.matchMedia("(prefers-color-scheme: dark)");
            const mqListener = (e: MediaQueryListEvent) => {
                setIsDarkTheme(e.matches);
            };
            darkThemeMq.addEventListener("change", mqListener);
            return () => darkThemeMq.removeEventListener("change", mqListener);
        }, []);
        return isDarkTheme;
    };

    const isDarkMode = useThemeDetector();

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
            const res = await fetch(`/api/site/${siteId}/analysis?date=${date}`);
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

    // Live Refresh for Today
    useEffect(() => {
        if (!isToday) return;

        const interval = setInterval(() => {
            fetchData();
        }, 60000); // 1 minute

        return () => clearInterval(interval);
    }, [isToday, fetchData]);

    const handleAddTag = async (tag: string) => {
        if (!taggingEvent) return;

        // Add to available tags if new
        if (!availableTags.includes(tag)) {
            setAvailableTags(prev => [...prev, tag]);
        }

        try {
            await fetch(`/api/site/${siteId}/analysis`, {
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
            await fetch(`/api/site/${siteId}/analysis`, {
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
        <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 p-6 font-sans transition-colors duration-300">
            <TagModal
                isOpen={!!taggingEvent}
                onClose={() => setTaggingEvent(null)}
                onSave={handleAddTag}
                currentTags={taggingEvent?.tags}
                availableTags={availableTags}
            />

            {/* Header */}
            <div className="mb-2">
                <Breadcrumbs items={[
                    { label: siteName, href: `/site/${siteId}` },
                    { label: 'Analysis' }
                ]} />
            </div>

            <div className="mb-6 flex flex-col sm:flex-row gap-4 sm:justify-between sm:items-center">
                <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-cyan-500 dark:from-cyan-400 dark:to-blue-500">
                    Load Analysis
                </h1>

                <div className="flex gap-2 items-center self-end sm:self-auto">
                    <div className="flex bg-white dark:bg-slate-900 rounded-lg p-1 shadow-sm border border-slate-200 dark:border-slate-800 items-center justify-between gap-1 shrink-0">
                        <button
                            onClick={() => changeDate(-1)}
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
                                className="font-semibold text-sm hover:underline decoration-blue-500 decoration-2 underline-offset-4 cursor-pointer rounded px-2 py-1 transition-colors w-full h-full flex items-center justify-center text-gray-900 dark:text-white"
                                title="Click to pick a date"
                            >
                                {displayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                                {isToday && ' (Today)'}
                            </div>
                            <input
                                ref={dateInputRef}
                                type="date"
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                value={date}
                                onChange={(e) => setDate(e.target.value)}
                                onClick={() => {
                                    try {
                                        dateInputRef.current?.showPicker();
                                    } catch {
                                        // Fallback
                                    }
                                }}
                                max={new Date().toISOString().split('T')[0]}
                            />
                        </div>

                        <button
                            onClick={() => changeDate(1)}
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
            </div>

            {/* Chart Section */}
            <div className="mb-8">
                {loading ? (
                    <div className="h-[500px] w-full flex items-center justify-center bg-gray-50 dark:bg-gray-900/50 rounded-xl border border-gray-200 dark:border-gray-800">
                        <span className="text-gray-500 dark:text-gray-400 animate-pulse">Loading High-Fidelity Data...</span>
                    </div>
                ) : (
                    <NILMChart
                        data={data}
                        events={events}
                        tariffs={tariffMap}
                        highlightedEvent={hoveredEvent}
                        selectedEvent={selectedEvent}
                        onEventClick={handleEventClick}
                        isDarkMode={isDarkMode}
                    />
                )}
            </div>

            {/* Event List (Card View) */}
            <div className="bg-white dark:bg-gray-900/50 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden shadow-sm">
                <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                    <h3 className="font-semibold text-lg text-gray-800 dark:text-gray-200">Detected Load Events</h3>
                </div>

                <div className="divide-y divide-gray-200 dark:divide-gray-800">
                    {events.length === 0 ? (
                        <div className="p-8 text-center text-gray-500 italic">
                            No significant load events detected for this day.
                        </div>
                    ) : (
                        events.map((ev, i) => {
                            const isSelected = selectedEvent === ev;
                            let cardClass = "p-4 transition-colors cursor-pointer active:bg-gray-50 dark:active:bg-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30 ";
                            if (isSelected) {
                                cardClass += "bg-blue-50 dark:bg-gray-800/30 border-l-4 border-blue-500 dark:border-cyan-400 ";
                            } else {
                                cardClass += "border-l-4 border-transparent ";
                            }

                            return (
                                <div
                                    key={i}
                                    className={cardClass}
                                    onClick={() => handleEventClick(ev)}
                                >
                                    {/* Header: Time & Duration */}
                                    <div className="flex justify-between items-start mb-3">
                                        <div>
                                            <div className="text-lg font-semibold text-cyan-600 dark:text-cyan-300">
                                                {formatTime(ev.startTime.toString())} - {formatTime(ev.endTime.toString())}
                                            </div>
                                            <div className="text-sm text-gray-500">
                                                Duration: {formatDuration(ev.durationMinutes)}
                                            </div>
                                        </div>
                                        <div className="text-xs font-mono text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                                            #{i + 1}
                                        </div>
                                    </div>

                                    {/* Stats Grid */}
                                    <div className="grid grid-cols-3 gap-4 mb-4 text-sm">
                                        <div>
                                            <div className="text-xs text-gray-500 uppercase">Avg Power</div>
                                            <div className="font-medium">{(ev.averagePower / 1000).toFixed(2)} kW</div>
                                        </div>
                                        <div>
                                            <div className="text-xs text-gray-500 uppercase">Max Power</div>
                                            <div className="font-medium text-amber-600 dark:text-amber-400">{(ev.maxPower / 1000).toFixed(2)} kW</div>
                                        </div>
                                        <div>
                                            <div className="text-xs text-gray-500 uppercase">Energy</div>
                                            <div className="font-medium text-green-600 dark:text-green-400">{ev.kwh} kWh</div>
                                        </div>
                                    </div>

                                    {/* Tags & Actions */}
                                    <div className="flex items-center justify-between mt-2">
                                        <div className="flex flex-wrap gap-2">
                                            {ev.tags?.map(tag => (
                                                <span key={tag} className={`px-2 py-0.5 rounded text-xs border flex items-center gap-1
                                                 ${tag === 'Arbitrage Candidate'
                                                        ? 'bg-red-100 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                                                        : 'bg-blue-100 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                                                    }`}>
                                                    {tag}
                                                    {tag !== 'Arbitrage Candidate' && (
                                                        <button
                                                            onClick={(e) => handleRemoveTag(e, ev, tag)}
                                                            className="ml-1 hover:text-black dark:hover:text-white"
                                                            title="Remove Tag"
                                                        >
                                                            &times;
                                                        </button>
                                                    )}
                                                </span>
                                            ))}
                                            {(!ev.tags || ev.tags.length === 0) && <span className="text-xs text-gray-400 italic">No tags</span>}
                                        </div>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setTaggingEvent(ev);
                                            }}
                                            className="ml-2 p-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-600 dark:text-gray-300"
                                            title="Tag Event"
                                        >
                                            ✏️
                                        </button>
                                    </div>
                                </div>
                            )
                        })
                    )}
                </div>
            </div>

            <div className="mt-8 p-4 bg-gray-100 dark:bg-gray-900/30 rounded-lg text-xs text-gray-500 dark:text-gray-500">
                <p>NILM Algorithm: Sliding Window Gradient (15m window) + Baseline Return Closure. Source: Total Home Load.</p>
            </div>
        </div >
    );
}
