'use client';

import { startTransition, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    HISTORY_CHANGED_EVENT,
    hotZone,
    runDataSync,
    syncAndNotify,
    type DataSyncDeps,
    type HistoryChangedDetail,
} from '@/lib/data-sync-client';

interface DataSyncerProps {
    siteId: string;
    start: Date;
    end: Date;
    viewDate?: Date; // The date the user is currently looking at
    /** Stored-history revision the rendered bill came from (Bill tab only). */
    historyRevision?: string | null;
}

export function DataSyncer({ siteId, start, end, viewDate, historyRevision = null }: DataSyncerProps) {
    const router = useRouter();
    const [status, setStatus] = useState<'idle' | 'checking' | 'active'>('idle');
    const [message, setMessage] = useState<string>('');

    // Track unique sync requests to prevent duplicates
    const [lastSyncKey, setLastSyncKey] = useState<string | null>(null);

    // Each server render brings the revision it shows; sync compares against it
    // without restarting when it changes.
    const knownRevision = useRef<{ current: string | null }>({ current: historyRevision });
    useEffect(() => {
        knownRevision.current.current = historyRevision;
    }, [historyRevision]);
    const tracksRevision = historyRevision !== null;

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

        const deps: DataSyncDeps = {
            siteId,
            fetch: (input, init) => fetch(input, init),
            signal,
            onStatus: (next, text) => {
                setStatus(next);
                if (text !== undefined) setMessage(text);
            },
            onIdle: () => setStatus('idle'),
            period: tracksRevision ? { start: startDate, end: endDate } : undefined,
            knownRevision: knownRevision.current,
            // Only when the shown data is outdated: this request rewrote stored
            // days, or the rendered bill's revision moved (another tab imported).
            // The Bill is server-rendered (router.refresh); History fetches its
            // chart on the client, so it listens for the event instead.
            onHistoryChanged: (changedDays) => {
                startTransition(() => router.refresh());
                window.dispatchEvent(new CustomEvent<HistoryChangedDetail>(HISTORY_CHANGED_EVENT, {
                    detail: { siteId, changedDays },
                }));
            },
        };

        const fullKey = `${siteId}|${startDate.toISOString()}|${endDate.toISOString()}|${hotZone(currentViewDate, new Date()).center.toDateString()}`;
        if (lastSyncKey !== fullKey) {
            runDataSync(deps, { start: startDate, end: endDate, viewDate: currentViewDate }).then(fullCompleted => {
                if (!signal.aborted && fullCompleted) setLastSyncKey(fullKey);
            });
        }

        // Auto-refresh for current day
        let intervalId: NodeJS.Timeout | undefined;
        const targetDate = currentViewDate || new Date();
        const isToday = targetDate.toDateString() === new Date().toDateString();

        if (isToday) {
            intervalId = setInterval(() => {
                const { start: hotStart, end: hotEnd } = hotZone(targetDate, new Date());
                // Never request the future; allow an hour of clock skew.
                const safeNow = new Date(Date.now() + 60 * 60 * 1000);
                syncAndNotify(deps, hotStart, hotEnd > safeNow ? safeNow : hotEnd);
            }, 60 * 60 * 1000); // 1 hour
        }

        return () => {
            abortController.abort();
            if (intervalId) clearInterval(intervalId);
        };
        // Dependencies are now primitives
    }, [siteId, startIso, endIso, viewDateIso, lastSyncKey, router, tracksRevision]);

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
