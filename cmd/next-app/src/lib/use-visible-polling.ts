'use client';

import { useEffect, useRef } from 'react';

interface UseVisiblePollingOptions {
    /**
     * Whether to invoke `callback` immediately on mount (in addition to scheduling
     * the interval). Defaults to true. Pass false when the initial render already
     * has fresh data (e.g. server-rendered server-component data).
     *
     * Note: returning to a visible tab always triggers an immediate invocation,
     * regardless of this option.
     */
    immediate?: boolean;
}

/**
 * Runs `callback` on an interval, pausing while the tab is hidden and firing
 * an immediate invocation when the tab becomes visible again. Avoids running
 * pollers in background tabs (saves API calls and bandwidth).
 *
 * The callback is captured via ref so consumers can pass inline closures
 * without restarting the interval on every render.
 */
export function useVisiblePolling(
    callback: () => void | Promise<void>,
    intervalMs: number,
    options: UseVisiblePollingOptions = {}
): void {
    const { immediate = true } = options;
    const callbackRef = useRef(callback);

    useEffect(() => {
        callbackRef.current = callback;
    }, [callback]);

    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;

        const fire = () => { void callbackRef.current(); };

        const start = () => {
            if (interval !== null) return;
            interval = setInterval(fire, intervalMs);
        };

        const stop = () => {
            if (interval !== null) {
                clearInterval(interval);
                interval = null;
            }
        };

        const isVisible = () =>
            typeof document === 'undefined' || document.visibilityState === 'visible';

        const onVisibilityChange = () => {
            if (isVisible()) {
                fire();
                start();
            } else {
                stop();
            }
        };

        if (isVisible()) {
            if (immediate) fire();
            start();
        }

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibilityChange);
        }

        return () => {
            stop();
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibilityChange);
            }
        };
    }, [intervalMs, immediate]);
}
