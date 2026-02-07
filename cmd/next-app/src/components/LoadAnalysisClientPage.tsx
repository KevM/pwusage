'use client';

import React, { useState, useEffect } from 'react';
import NILMChart from '@/components/NILMChart';
import { PowerData } from '@/lib/nilm/types';
import { LoadEvent } from '@/lib/nilm/load-detection';

import { useSearchParams } from 'next/navigation';

import TagModal from '@/components/TagModal';

interface LoadAnalysisClientPageProps {
    siteId: string;
    siteName: string;
    defaultDate?: string;
    siteTimezone: string;
    displayMode: 'SITE' | 'BROWSER';
}

export default function LoadAnalysisClientPage({ siteId, defaultDate, siteTimezone, displayMode }: LoadAnalysisClientPageProps) {
    const searchParams = useSearchParams();
    const initialDate = searchParams.get('date') || defaultDate || new Date().toISOString().split('T')[0];

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
    const [hoveredEvent] = useState<LoadEvent | null>(null);
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
        const [isDarkTheme, setIsDarkTheme] = useState(false);

        useEffect(() => {
            const getCurrentTheme = () => typeof window !== 'undefined' ? window.matchMedia("(prefers-color-scheme: dark)").matches : false;
            setIsDarkTheme(getCurrentTheme());

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

    // Refs for scrolling
    const eventRefs = React.useRef<Record<number, HTMLDivElement | null>>({});

    const handleEventClick = (ev: LoadEvent) => {
        // Compare by startTime instead of object identity
        if (selectedEvent && new Date(selectedEvent.startTime).getTime() === new Date(ev.startTime).getTime()) {
            setSelectedEvent(null);
        } else {
            setSelectedEvent(ev);
        }
    };

    // Auto-scroll when an event is selected
    useEffect(() => {
        if (selectedEvent) {
            // Find matching index in current events list
            const index = events.findIndex(e => new Date(e.startTime).getTime() === new Date(selectedEvent.startTime).getTime());
            if (index >= 0 && eventRefs.current[index]) {
                eventRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }, [selectedEvent, events]);

    const fetchData = React.useCallback(async (showLoading = true) => {
        if (!siteId) return;
        if (showLoading) setLoading(true);
        try {
            // Determine target timezone
            const targetTz = displayMode === 'BROWSER' ? Intl.DateTimeFormat().resolvedOptions().timeZone : siteTimezone;
            const res = await fetch(`/api/site/${siteId}/analysis?date=${date}&tz=${targetTz}`);
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
    }, [siteId, date, displayMode, siteTimezone]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    // Live Refresh for Today
    useEffect(() => {
        if (!isToday) return;

        const interval = setInterval(() => {
            fetchData(false);
        }, 300000); // 5 minutes

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

    // const handleRemoveTag = async (e: React.MouseEvent, event: LoadEvent, tag: string) => { ... } // Unused

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
        <div className="text-gray-900 dark:text-gray-100 font-sans transition-colors duration-300">
            <TagModal
                isOpen={!!taggingEvent}
                onClose={() => setTaggingEvent(null)}
                onSave={handleAddTag}
                currentTags={taggingEvent?.tags}
                availableTags={availableTags}
            />

            {/* Header */}
            {/* Breadcrumbs removed as requested */}

            {/* Breadcrumbs removed as requested */}

            {/* Unified History Card */}
            <div className="mb-8 bg-white dark:bg-gray-900/50 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden shadow-sm">
                {/* Header: Title & Controls */}
                <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 flex flex-col sm:flex-row gap-4 sm:justify-between sm:items-center">
                    <h2 className="text-xl font-semibold dark:text-gray-200">
                        Usage History
                    </h2>

                    <div className="flex gap-2 items-center self-end sm:self-auto">
                        <div className="flex bg-white dark:bg-slate-800 rounded-lg p-1 shadow-sm border border-gray-200 dark:border-slate-700 items-center justify-between gap-1 shrink-0">
                            <button
                                onClick={() => changeDate(-1)}
                                disabled={loading}
                                className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-none"
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
                                className="p-1.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-none"
                                title="Next Day"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="m9 18 6-6-6-6" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                {/* Chart Body */}
                <div className="p-4">
                    {loading ? (
                        <div className="h-[500px] w-full flex items-center justify-center">
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
                            siteTimezone={siteTimezone}
                            displayMode={displayMode}
                        />
                    )}
                </div>
            </div>

            {/* Event List (Card View) */}
            <div className="bg-white dark:bg-gray-900/50 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden shadow-sm">
                <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                    <h3 className="font-semibold text-lg text-gray-800 dark:text-gray-200">Detected Load Events</h3>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 p-4">
                    {events.length === 0 ? (
                        <div className="col-span-full p-8 text-center text-gray-500 italic">
                            No significant load events detected for this day.
                        </div>
                    ) : (
                        events.map((ev, i) => {
                            const isSelected = selectedEvent && new Date(selectedEvent.startTime).getTime() === new Date(ev.startTime).getTime();
                            // Compact Card Styles
                            let cardClass = "p-2 rounded-lg border transition-all cursor-pointer shadow-sm hover:shadow-md active:scale-95 ";
                            if (isSelected) {
                                cardClass += "bg-blue-50 dark:bg-blue-900/20 border-blue-500 ring-1 ring-blue-500 dark:border-blue-400 ";
                            } else {
                                cardClass += "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700 ";
                            }

                            return (
                                <div
                                    key={i}
                                    ref={el => { eventRefs.current[i] = el }}
                                    className={cardClass}
                                    onClick={() => handleEventClick(ev)}
                                >
                                    {/* Header: Compact Time & Id */}
                                    <div className="flex justify-between items-start mb-1.5">
                                        <div>
                                            <div className="text-base font-bold text-gray-900 dark:text-gray-100">
                                                {formatTime(ev.startTime.toString())} - {formatTime(ev.endTime.toString())}
                                            </div>
                                            <div className="text-xs text-gray-500">
                                                {formatDuration(ev.durationMinutes)}
                                            </div>
                                        </div>
                                        <div className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                                            #{i + 1}
                                        </div>
                                    </div>

                                    {/* Stats Grid: Compact */}
                                    <div className="grid grid-cols-3 gap-2 mb-2 text-xs p-1">
                                        <div>
                                            <div className="text-[10px] text-gray-500 uppercase font-semibold">Avg</div>
                                            <div className="font-semibold text-sm text-gray-700 dark:text-gray-300">{(ev.averagePower / 1000).toFixed(1)}kW</div>
                                        </div>
                                        <div>
                                            <div className="text-[10px] text-gray-500 uppercase font-semibold">Max</div>
                                            <div className="font-semibold text-sm text-amber-600 dark:text-amber-400">{(ev.maxPower / 1000).toFixed(1)}kW</div>
                                        </div>
                                        <div>
                                            <div className="text-[10px] text-gray-500 uppercase font-semibold">kWh</div>
                                            <div className="font-semibold text-sm text-green-600 dark:text-green-400">{ev.kwh.toFixed(1)}</div>
                                        </div>
                                    </div>

                                    {/* Tags & Actions */}
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex flex-wrap gap-1 min-h-[1.25rem]">
                                            {ev.tags?.slice(0, 3).map(tag => (
                                                <span key={tag} className={`px-1.5 py-0.5 rounded-[4px] text-[10px] border flex items-center gap-0.5
                                                 ${tag === 'Arbitrage Candidate'
                                                        ? 'bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-900 text-red-700 dark:text-red-300'
                                                        : 'bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-900 text-blue-700 dark:text-blue-300'
                                                    }`}>
                                                    <span className="truncate max-w-[60px]">{tag}</span>
                                                </span>
                                            ))}
                                            {(ev.tags?.length || 0) > 3 && (
                                                <span className="text-[10px] text-gray-400">+{ev.tags!.length - 3}</span>
                                            )}
                                        </div>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setTaggingEvent(ev);
                                            }}
                                            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                                            title="Edit Tags"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                                <path d="M5.433 13.917l1.262-3.155A4 4 0 017.58 9.42l6.92-6.918a2.121 2.121 0 013 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 01-.65-.65z" />
                                                <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0010 3H4.75A2.75 2.75 0 002 5.75v9.5A2.75 2.75 0 004.75 18h9.5A2.75 2.75 0 0017 15.25V10a.75.75 0 00-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5z" />
                                            </svg>
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
