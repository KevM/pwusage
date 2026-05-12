'use client';

import React, { useState, useEffect } from 'react';
import NILMChart from '@/components/NILMChart';
import { PowerData } from '@/lib/nilm/types';
import { LoadEvent } from '@/lib/nilm/load-detection';
import { DateNavigator, DateNavigatorButton, DateNavigatorContent, DateNavigatorLabel } from '@/components/ui/DateNavigator';
import { Card, CardBody, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';

import TagModal from '@/components/TagModal';

interface LoadAnalysisClientPageProps {
    siteId: string;
    siteName: string;
    defaultDate?: string;
    siteTimezone: string;
    displayMode: 'SITE' | 'BROWSER';
}

export default function LoadAnalysisClientPage({ siteId, defaultDate, siteTimezone, displayMode }: LoadAnalysisClientPageProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const initialDate = searchParams.get('date') || defaultDate || new Date().toISOString().split('T')[0];

    // Initialize date from URL or Today
    const [date, setDate] = useState<string>(initialDate);

    // Sync state with URL using the render-phase pattern:
    // https://react.dev/reference/react/useState#storing-information-from-previous-renders
    const [syncedSearchDate, setSyncedSearchDate] = useState<string | null>(searchParams.get('date'));
    const currentSearchDate = searchParams.get('date');
    if (currentSearchDate !== syncedSearchDate) {
        setSyncedSearchDate(currentSearchDate);
        if (currentSearchDate && currentSearchDate !== date) {
            setDate(currentSearchDate);
        }
    }

    const updateUrl = (newDate: string) => {
        const params = new URLSearchParams(searchParams);
        params.set('date', newDate);
        router.push(`${pathname}?${params.toString()}`);
    };

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

    const [loading, setLoading] = useState(true);
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
    const displayDateStr = React.useMemo(() => {
        const [y, m, d] = date.split('-').map(Number);
        const dt = new Date(y, m - 1, d, 12, 0, 0);
        return new Intl.DateTimeFormat('en-US', {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
            timeZone: displayMode === 'SITE' ? siteTimezone : undefined
        }).format(dt);
    }, [date, siteTimezone, displayMode]);

    const isToday = React.useMemo(() => {
        const now = new Date();
        const todayStr = new Intl.DateTimeFormat('en-CA', {
            timeZone: displayMode === 'SITE' ? siteTimezone : undefined,
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(now);
        return date === todayStr;
    }, [date, siteTimezone, displayMode]);

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
        if (!siteId) return;
        let cancelled = false;
        const targetTz = displayMode === 'BROWSER' ? Intl.DateTimeFormat().resolvedOptions().timeZone : siteTimezone;
        fetch(`/api/site/${siteId}/analysis?date=${date}&tz=${targetTz}`)
            .then((res) => {
                if (!res.ok) throw new Error('Failed to fetch data');
                return res.json();
            })
            .then((json) => {
                if (cancelled) return;
                setData(json.data);
                setEvents(json.events || []);
                setTariffMap(json.tariffs || {});
                setLoading(false);
            })
            .catch((err) => {
                if (cancelled) return;
                console.error(err);
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [siteId, date, displayMode, siteTimezone]);

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
        const newDate = `${y}-${m}-${day}`;
        setDate(newDate);
        updateUrl(newDate);
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
            <Card className="mb-8 overflow-hidden">
                {/* Header: Title & Controls */}
                <CardHeader className="bg-gray-50 dark:bg-gray-900/50 flex flex-col sm:flex-row gap-4 sm:justify-between sm:items-center">
                    <CardTitle>Usage History</CardTitle>

                    <div className="flex gap-2 items-center self-end sm:self-auto">
                        <DateNavigator>
                            <DateNavigatorButton
                                onClick={() => changeDate(-1)}
                                direction="prev"
                                disabled={loading}
                            />

                            <DateNavigatorContent>
                                <DateNavigatorLabel
                                    className="hover:underline decoration-blue-500 decoration-2 underline-offset-4"
                                    title="Click to pick a date"
                                    onClick={() => {
                                        try {
                                            dateInputRef.current?.showPicker();
                                        } catch {
                                            // Fallback
                                        }
                                    }}
                                >
                                    {displayDateStr}
                                    {isToday && ' (Today)'}
                                </DateNavigatorLabel>
                                <input
                                    ref={dateInputRef}
                                    type="date"
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                    value={date}
                                    onChange={(e) => {
                                        setDate(e.target.value);
                                        updateUrl(e.target.value);
                                    }}
                                    onClick={(e) => {
                                        // Stop propagation so label onClick handles it if needed
                                        e.stopPropagation();
                                    }}
                                    max={new Date().toISOString().split('T')[0]}
                                />
                            </DateNavigatorContent>

                            <DateNavigatorButton
                                onClick={() => changeDate(1)}
                                direction="next"
                                disabled={loading || isToday}
                            />
                        </DateNavigator>
                    </div>
                </CardHeader>

                {/* Chart Body */}
                <CardContent className="p-4 pt-4">
                    {loading ? (
                        <div className="h-[500px] w-full flex items-center justify-center">
                            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                                <Spinner />
                                <span>Loading High-Fidelity Data...</span>
                            </div>
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
                </CardContent>
            </Card>

            {/* Event List (Card View) */}
            <Card className="overflow-hidden">
                <CardHeader className="bg-gray-50 dark:bg-gray-900/50 items-center text-center">
                    <CardTitle className="text-lg">Detected Load Events</CardTitle>
                </CardHeader>

                <CardContent className="pt-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {events.length === 0 ? (
                            <div className="col-span-full">
                                <EmptyState
                                    title="No significant load events"
                                    description="No significant load events were detected for this day."
                                />
                            </div>
                        ) : (
                            events.map((ev, i) => {
                                const isSelected = selectedEvent && new Date(selectedEvent.startTime).getTime() === new Date(ev.startTime).getTime();
                                let cardClass = "transition-shadow cursor-pointer hover:shadow-md ";
                                if (isSelected) {
                                    cardClass += "ring-1 ring-gray-300 dark:ring-slate-600 ";
                                }

                                return (
                                    <Card
                                        key={i}
                                        ref={el => { eventRefs.current[i] = el }}
                                        density="compact"
                                        className={`relative ${cardClass}`}
                                        onClick={() => handleEventClick(ev)}
                                    >
                                        <Badge className="absolute right-1.5 top-1.5 font-mono text-[10px] px-0 py-0 m-0 rounded-md">
                                            #{i + 1}
                                        </Badge>

                                        <CardBody density="compact">
                                            {/* Header: Compact Time & Id */}
                                            <div className="mb-1.5 min-w-0 pr-10">
                                                <CardTitle density="compact" className="leading-tight">
                                                    {formatTime(ev.startTime.toString())} - {formatTime(ev.endTime.toString())}
                                                </CardTitle>
                                            </div>
                                            <div className="text-xs text-gray-500 mb-2">
                                                {formatDuration(ev.durationMinutes)}
                                            </div>

                                            {/* Stats Grid: Compact */}
                                            <div className="grid grid-cols-3 gap-2 mb-2 text-xs">
                                                <div>
                                                    <div className="text-[10px] text-gray-500 uppercase font-semibold">Avg</div>
                                                    <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">{(ev.averagePower / 1000).toFixed(1)}kW</div>
                                                </div>
                                                <div>
                                                    <div className="text-[10px] text-gray-500 uppercase font-semibold">Max</div>
                                                    <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">{(ev.maxPower / 1000).toFixed(1)}kW</div>
                                                </div>
                                                <div>
                                                    <div className="text-[10px] text-gray-500 uppercase font-semibold">kWh</div>
                                                    <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">{ev.kwh.toFixed(1)}</div>
                                                </div>
                                            </div>

                                            {/* Tags & Actions */}
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="flex flex-wrap gap-0.5 min-h-[1.25rem]">
                                                    {ev.tags?.slice(0, 3).map(tag => (
                                                        <Badge key={tag} className="text-[10px] px-1.5 py-0 rounded-md max-w-[84px]">
                                                            <span className="truncate">{tag}</span>
                                                        </Badge>
                                                    ))}
                                                    {(ev.tags?.length || 0) > 3 && (
                                                        <Badge className="text-[10px] px-1.5 py-0 rounded-md">
                                                            +{ev.tags!.length - 3}
                                                        </Badge>
                                                    )}
                                                </div>
                                                <Button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setTaggingEvent(ev);
                                                    }}
                                                    appearance="glyph"
                                                    size="sm"
                                                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                                                    title="Edit Tags"
                                                    aria-label="Edit tags"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                                        <path d="M5.433 13.917l1.262-3.155A4 4 0 017.58 9.42l6.92-6.918a2.121 2.121 0 013 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 01-.65-.65z" />
                                                        <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0010 3H4.75A2.75 2.75 0 002 5.75v9.5A2.75 2.75 0 004.75 18h9.5A2.75 2.75 0 0017 15.25V10a.75.75 0 00-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5z" />
                                                    </svg>
                                                </Button>
                                            </div>
                                        </CardBody>
                                    </Card>
                                );
                            })
                        )}
                    </div>
                </CardContent>
            </Card>

        </div >
    );
}
