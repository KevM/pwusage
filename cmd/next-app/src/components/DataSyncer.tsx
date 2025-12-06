
'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface DataSyncerProps {
    siteId: string;
    start: Date;
    end: Date;
    viewDate?: Date; // The date the user is currently looking at
}

export function DataSyncer({ siteId, start, end, viewDate }: DataSyncerProps) {
    const router = useRouter();
    const [status, setStatus] = useState<'idle' | 'checking' | 'active'>('idle');
    const [message, setMessage] = useState<string>('');

    // Track unique sync requests to prevent duplicates
    const [lastSyncKey, setLastSyncKey] = useState<string | null>(null);

    useEffect(() => {
        const abortController = new AbortController();
        const signal = abortController.signal;

        const runSyncSequence = async () => {
            // Determine our "Hot Zone" (User's view date +/- 3 days)
            // This ensures the chart fills in ASAP.
            const centerDate = viewDate || new Date();
            // Normalize to midnight to prevent infinite loops when "now" changes by milliseconds
            centerDate.setHours(0, 0, 0, 0);

            const hotStart = new Date(centerDate);
            hotStart.setDate(hotStart.getDate() - 3);
            const hotEnd = new Date(centerDate);
            hotEnd.setDate(hotEnd.getDate() + 3);

            // Construct a unique key for this configuration to avoid re-runs
            const fullKey = `${siteId}|${start.toISOString()}|${end.toISOString()}|${centerDate.toDateString()}`;
            if (lastSyncKey === fullKey) return;

            // 1. STAGE 1: HOT ZONE SYNC
            // Only if it overlaps with the requested range (optimization)
            if (hotStart < end && hotEnd > start) {
                await runSyncStep(hotStart, hotEnd, signal, true);
                if (signal.aborted) return;
            }

            // 2. STAGE 2: FULL PERIOD SYNC
            // Ensure the entire billing period is covered for the Bill Summary
            await runSyncStep(start, end, signal, false);

            if (!signal.aborted) {
                setLastSyncKey(fullKey);
            }
        };

        const runSyncStep = async (s: Date, e: Date, sig: AbortSignal, refreshAfter: boolean) => {
            setStatus('checking');
            try {
                const params = new URLSearchParams({
                    siteId,
                    start: s.toISOString(),
                    end: e.toISOString()
                });

                const res = await fetch(`/api/sync?${params.toString()}`, { signal: sig });
                if (!res.ok) return;

                const reader = res.body?.getReader();
                if (!reader) return;

                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (sig.aborted) break;

                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                if (data.status === 'checking') {
                                    setStatus('checking');
                                } else if (data.status === 'progress') {
                                    setStatus('active');
                                    setMessage(data.message);
                                } else if (data.status === 'complete') {
                                    if (refreshAfter) {
                                        // Refresh purely for the chart update
                                        import('react').then(({ startTransition }) => {
                                            startTransition(() => {
                                                router.refresh();
                                            });
                                        });
                                    }
                                }
                            } catch (e) {
                                // ignore
                            }
                        }
                    }
                }
            } catch (err: any) {
                if (err.name !== 'AbortError') {
                    console.error('Info sync error:', err);
                }
            } finally {
                if (!sig.aborted) {
                    setStatus('idle');
                    // Always refresh at the end of a step to ensure UI consistency
                    if (!refreshAfter) {
                        import('react').then(({ startTransition }) => {
                            startTransition(() => {
                                router.refresh();
                            });
                        });
                    }
                }
            }
        }

        runSyncSequence();

        // Auto-refresh for current day
        let intervalId: NodeJS.Timeout | undefined;
        const targetDate = viewDate || new Date();
        const now = new Date();
        const isToday = targetDate.toDateString() === now.toDateString();

        if (isToday) {
            intervalId = setInterval(() => {
                // Determine our "Hot Zone" (User's view date +/- 3 days)
                const hotStart = new Date(targetDate);
                hotStart.setDate(hotStart.getDate() - 3);
                const hotEnd = new Date(targetDate);
                hotEnd.setDate(hotEnd.getDate() + 3);

                // Force a sync of the hot zone. 
                // We pass refreshAfter=true to update the chart.
                // Note: We need a fresh signal if possible, or just ignore abortion for interval?
                // Using the main signal means if the component unmounts, this stops too.
                runSyncStep(hotStart, hotEnd, signal, true);
            }, 60 * 60 * 1000); // 1 hour
        }

        return () => {
            abortController.abort();
            if (intervalId) clearInterval(intervalId);
        };
        // Use primitive values for dependencies to avoid infinite re-renders when Date objects are recreated
        // Normalize viewDate to a date string (no time) to prevent loops when "now" changes.
    }, [siteId, start.toISOString(), end.toISOString(), viewDate ? viewDate.toDateString() : 'no-view-date', lastSyncKey]);

    if (status === 'idle') return null;

    return (
        <div className="fixed bottom-4 right-4 bg-blue-600/90 text-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium backdrop-blur-sm z-50 flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
            <div>
                {status === 'checking' && "Checking data..."}
                {status === 'active' && (message || "Syncing...")}
            </div>
        </div>
    );
}
