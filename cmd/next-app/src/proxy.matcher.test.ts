import { describe, expect, it } from 'vitest';
// Kept separate from proxy.test.ts: loading Next's testing utils alongside the
// proxy handler breaks NextResponse cookie handling (AsyncLocalStorage invariant).
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from './proxy';

describe('proxy matcher', () => {
    it('runs on app routes', () => {
        expect(unstable_doesMiddlewareMatch({ config, url: '/dashboard' })).toBe(true);
    });

    it('skips .well-known assets so they never receive a site_auth Set-Cookie', () => {
        expect(unstable_doesMiddlewareMatch({
            config,
            url: '/.well-known/appspecific/com.tesla.3p.public-key.pem',
        })).toBe(false);
    });
});
