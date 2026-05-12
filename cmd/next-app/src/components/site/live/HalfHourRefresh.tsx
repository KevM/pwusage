'use client';

import { useRouter } from 'next/navigation';
import { useVisiblePolling } from '@/lib/use-visible-polling';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/**
 * Triggers a soft re-render of the surrounding server component every 30
 * minutes (and immediately when the tab regains visibility), so cycle and
 * "today so far" aggregates stay reasonably fresh without a full reload.
 *
 * Renders nothing. Initial mount does NOT refresh — the page already has
 * fresh server-rendered data on first paint.
 */
export function HalfHourRefresh() {
    const router = useRouter();
    useVisiblePolling(() => {
        router.refresh();
    }, THIRTY_MINUTES_MS, { immediate: false });
    return null;
}
