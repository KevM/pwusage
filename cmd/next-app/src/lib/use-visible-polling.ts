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

/** The parts of `document` the poller needs; injectable for tests. */
export interface VisibilitySource {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Calls `fire` every `intervalMs` while `source` is visible, stops while it is
 * hidden, and fires immediately when it becomes visible again. Returns a stop
 * function. `source` undefined (server render) counts as visible.
 */
export function startVisiblePolling(
    source: VisibilitySource | undefined,
    fire: () => void,
    intervalMs: number,
    immediate: boolean
): () => void {
    let interval: ReturnType<typeof setInterval> | null = null;

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

    const isVisible = () => !source || source.visibilityState === 'visible';

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
    source?.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
        stop();
        source?.removeEventListener('visibilitychange', onVisibilityChange);
    };
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

    useEffect(() => startVisiblePolling(
        typeof document === 'undefined' ? undefined : document,
        () => { void callbackRef.current(); },
        intervalMs,
        immediate
    ), [intervalMs, immediate]);
}
