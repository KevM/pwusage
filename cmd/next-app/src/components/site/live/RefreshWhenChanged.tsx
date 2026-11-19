'use client';

import { startTransition, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Whether a streamed refresh result should re-render the page: it stored
 * something new, and this render's refresh (`cycle`) has not been handled yet.
 * The component stays mounted across `router.refresh()`, so the guard is per
 * cycle, not per mount: later refreshes (e.g. `HalfHourRefresh`) still apply.
 */
export function shouldRefreshForCycle(changed: boolean, cycle: string, handledCycle: string | null): boolean {
    return changed && cycle !== handledCycle;
}

/**
 * Streamed in after the Live page's background Tesla refresh finishes. When it
 * stored something new, re-render the page once for that refresh so the open
 * page shows it.
 */
export function RefreshWhenChanged({ changed, cycle }: { changed: boolean; cycle: string }) {
    const router = useRouter();
    const handledCycle = useRef<string | null>(null);
    useEffect(() => {
        if (!shouldRefreshForCycle(changed, cycle, handledCycle.current)) return;
        handledCycle.current = cycle;
        startTransition(() => router.refresh());
    }, [changed, cycle, router]);
    return null;
}
