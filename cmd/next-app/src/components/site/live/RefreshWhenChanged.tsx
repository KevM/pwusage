'use client';

import { startTransition, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Streamed in after the Live page's background Tesla refresh finishes. When it
 * stored something new, re-render the page once so the open page shows it.
 */
export function RefreshWhenChanged({ changed }: { changed: boolean }) {
    const router = useRouter();
    const done = useRef(false);
    useEffect(() => {
        if (!changed || done.current) return;
        done.current = true;
        startTransition(() => router.refresh());
    }, [changed, router]);
    return null;
}
