import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';

const ORIGIN = 'https://pwusage.test';

function logoutRequest(method: 'GET' | 'POST', headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`${ORIGIN}/logout`, {
        method,
        headers: { cookie: 'site_auth=session-token', ...headers },
        ...(method === 'POST' ? { body: '' } : {}),
    });
}

/** The Set-Cookie header that would clear the session, if the response sent one. */
function sessionCookieHeader(response: Response): string | undefined {
    return response.headers.getSetCookie().find(cookie => cookie.startsWith('site_auth='));
}

function expectSessionCleared(response: Response): void {
    const header = sessionCookieHeader(response);
    expect(header).toBeDefined();
    expect(header).toMatch(/^site_auth=;/);
    expect(header).toMatch(/Max-Age=0/i);
    expect(header).toMatch(/Path=\//i);
}

describe('/logout', () => {
    it('does not sign out on GET, so links, prefetches and images cannot end a session', async () => {
        const response = await GET();
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
        expect(sessionCookieHeader(response)).toBeUndefined();
    });

    it.each([
        ['another Origin', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
        ['a cross-site fetch without Origin', { 'sec-fetch-site': 'cross-site' }],
        ['a malformed Origin', { origin: 'null' }],
    ])('refuses a POST from %s and leaves the session intact', async (_label, headers) => {
        const response = await POST(logoutRequest('POST', headers));
        expect(response.status).toBe(403);
        expect(sessionCookieHeader(response)).toBeUndefined();
    });

    it('signs out a same-origin web form and sends the browser home with a GET', async () => {
        const response = await POST(logoutRequest('POST', {
            origin: ORIGIN,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/x-www-form-urlencoded',
        }));
        // 303, not 307/308: the browser must follow with GET /, not re-POST to the home page.
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(`${ORIGIN}/`);
        expectSessionCleared(response);
    });

    it('signs out the native client, whose URLSession request carries no Origin', async () => {
        const response = await POST(logoutRequest('POST'));
        expect(response.status).toBe(303);
        expectSessionCleared(response);
    });
});
