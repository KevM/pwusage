
'use client';

import { useEffect, useState } from 'react';
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

    // Stabilize dependencies
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const viewDateIso = viewDate ? viewDate.toDateString() : 'no-view-date';

    useEffect(() => {
        const abortController = new AbortController();
        const signal = abortController.signal;

        // Rehydrate
        const startDate = new Date(startIso);
        const endDate = new Date(endIso);
        const currentViewDate = viewDateIso === 'no-view-date' ? undefined : new Date(viewDateIso);

        const runSyncSequence = async () => {
            // Determine our "Hot Zone" (User's view date +/- 3 days)
            // This ensures the chart fills in ASAP.
            const centerDate = currentViewDate || new Date();
            // Normalize to midnight to prevent infinite loops when "now" changes by milliseconds
            centerDate.setHours(0, 0, 0, 0);

            const hotStart = new Date(centerDate);
            hotStart.setDate(hotStart.getDate() - 3);
            const hotEnd = new Date(centerDate);
            hotEnd.setDate(hotEnd.getDate() + 3);

            // CLAMP TO NOW: Prevent requesting future data
            const now = new Date();
            // allow up to "end of today" basically, or just strictly now.
            // If hotEnd is Dec 12 00:00 and now is Dec 9 10:00, we should cap at Dec 9 (or Dec 10 00:00).
            // Let's cap at (now + 1 hour) to be safe for slight clock skew, but generally "now".
            const safeNow = new Date(now.getTime() + 60 * 60 * 1000);

            const cappedHotEnd = hotEnd > safeNow ? safeNow : hotEnd;
            const cappedEnd = endDate > safeNow ? safeNow : endDate;
            const cappedStart = startDate > safeNow ? safeNow : startDate;

            // If start is in future, don't sync.
            if (cappedStart > safeNow) return;

            // Construct a unique key for this configuration to avoid re-runs
            // Use the capped values for the key to ensure we don't re-run just because the uncapped future changed?
            // Actually, keep dependent on props but check if we've run this *effective* sync.
            const fullKey = `${siteId}|${startDate.toISOString()}|${endDate.toISOString()}|${centerDate.toDateString()}`;
            if (lastSyncKey === fullKey) return;

            // 1. STAGE 1: HOT ZONE SYNC
            // Only if it overlaps with the requested range (optimization)
            if (hotStart < cappedEnd && cappedHotEnd > cappedStart) {
                // Ensure we don't send flipped ranges
                const s = hotStart < cappedStart ? cappedStart : hotStart;
                const e = cappedHotEnd;
                if (s < e) {
                    await runSyncStep(s, e, signal, true);
                    if (signal.aborted) return;
                }
            }

            // 2. STAGE 2: FULL PERIOD SYNC
            // Ensure the entire billing period is covered for the Bill Summary
            // Only run if effective end > effective start
            if (cappedStart < cappedEnd) {
                await runSyncStep(cappedStart, cappedEnd, signal, false);
            }

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
                            } catch {
                                // ignore
                            }
                        }
                    }
                }
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
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
        const targetDate = currentViewDate || new Date();
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
        // Dependencies are now primitives
    }, [siteId, startIso, endIso, viewDateIso, lastSyncKey, router]);

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
