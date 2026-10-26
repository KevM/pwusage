import type { NextRequest } from 'next/server';

export const LOGIN_ATTEMPT_SECONDS = 10 * 60;
export const MAX_LOGIN_ATTEMPTS = 8;
const ATTEMPT_STATE = /^v2\.([a-f0-9]{32})$/;
const COOKIE_PREFIX = 'auth_attempt_';
const PRODUCTION_ORIGIN = 'https://pwusage.fm.rodeo';

export interface TeslaLoginAttempt {
    nonce: string;
    loginId: string;
    expiresAt: number;
    callback?: string;
    mobileAttemptId?: string;
    mobileChallenge?: string;
    mobileState?: string;
}

export function loginAttemptCookieName(state: string): string | undefined {
    const match = ATTEMPT_STATE.exec(state);
    return match ? `${COOKIE_PREFIX}${match[1]}` : undefined;
}

export function isAttemptCookie(name: string): boolean {
    return /^auth_attempt_[a-f0-9]{32}$/.test(name);
}

export function readLoginAttempt(value: string | undefined): TeslaLoginAttempt | undefined {
    if (!value) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object') return undefined;
        const attempt = parsed as Record<string, unknown>;
        if (typeof attempt.loginId !== 'string' || !/^[a-f0-9-]{36}$/.test(attempt.loginId)
            || typeof attempt.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(attempt.nonce)
            || typeof attempt.expiresAt !== 'number' || !Number.isFinite(attempt.expiresAt)
            || attempt.expiresAt <= Date.now()
            || attempt.expiresAt > Date.now() + LOGIN_ATTEMPT_SECONDS * 1000) return undefined;
        for (const key of ['callback', 'mobileAttemptId', 'mobileChallenge', 'mobileState']) {
            if (attempt[key] !== undefined && typeof attempt[key] !== 'string') return undefined;
        }
        return attempt as unknown as TeslaLoginAttempt;
    } catch {
        return undefined;
    }
}

export function safeLoginCallback(callback: string | null): string | undefined {
    return callback && callback.length <= 1024 && callback.startsWith('/')
        && !callback.startsWith('//') && !/[\\\x00-\x20\x7f]/.test(callback) ? callback : undefined;
}

/** Do not create cookies on an alias and then send the callback to the canonical host. */
export function productionLoginRedirect(request: NextRequest): URL | undefined {
    if (process.env.VERCEL_ENV !== 'production' || request.nextUrl.origin === PRODUCTION_ORIGIN) return undefined;
    return new URL(request.nextUrl.pathname + request.nextUrl.search, PRODUCTION_ORIGIN);
}

export function isLoginPrefetch(request: NextRequest): boolean {
    return request.headers.has('next-router-prefetch')
        || /prefetch/i.test(request.headers.get('purpose') ?? '')
        || /prefetch/i.test(request.headers.get('sec-purpose') ?? '');
}

/** Production auth never depends on an accidentally changed public URL setting. */
export function teslaLoginBaseUrl(configuredUrl: string): string {
    return process.env.VERCEL_ENV === 'production' ? PRODUCTION_ORIGIN : configuredUrl;
}
