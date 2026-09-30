# Tesla OAuth Spec Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align pwusage's Tesla OAuth implementation with Tesla's documented Fleet API behavior, closing six verified deviations — most importantly a JWKS fallback that resolves the wrong key set and silently downgrades ID token signature verification.

**Architecture:** Extract Tesla `/token` POSTs into one small module that owns host selection (documented `fleet-auth` host first, `auth.tesla.com` as fallback on network/5xx only). In the auth service, make JWKS resolution issuer-aware, delete the hand-rolled key refresh in favour of jwks-rsa's built-in refetch-on-miss, and move all timeouts down onto the HTTP layer so a warm cache hit can never hang.

**Tech Stack:** TypeScript, Next.js 15 (App Router), `jsonwebtoken`, `jwks-rsa` v4.1.0, Vitest.

**Design doc:** `docs/plans/2026-09-30-tesla-oauth-spec-alignment-design.md`

---

## Critical context for the implementer

**Do not skip this section.** Several of these facts are counter-intuitive and are the entire reason the bugs exist.

1. **Tesla's two issuers publish different key sets.** Verified live 2026-09-30:
   - `https://auth.tesla.com/oauth2/v3/nts` → `.../v3/discovery/thirdparty/keys`
   - `https://auth.tesla.com/oauth2/v3` → `.../v3/discovery/keys`

   Tesla issues `/nts` ID tokens. The current hardcoded fallback (`.../discovery/keys`) is correct for the base issuer and **wrong for the one Tesla actually uses**.

2. **jwks-rsa v4 already refetches on an unknown `kid`.** From `node_modules/jwks-rsa/src/JwksClient.js` and `src/wrappers/cache.js`, the pipeline is:

   ```
   callbackSupport( rateLimit( cacheSigningKey( JwksClient.getSigningKey ) ) )
   ```

   `cacheSigningKey` memoizes **per `kid`** via `lru-memoizer` (`ttl: cacheMaxAge`). There is **no second-level cache of the key set**, so a `kid` miss falls through to `getKeys()`, which performs a fresh HTTP fetch — rate-limited by `rateLimitSigningKey`. Execution order means the rate limiter only applies on cache misses, which is the correct posture.

   Therefore the existing hand-rolled `fetchFreshJwks` retry is redundant, bypasses the rate limiter, and reads a possibly-wrong URI. It is being deleted.

3. **Error names matter for the security gate.** jwks-rsa raises:
   - `SigningKeyNotFoundError` — endpoint was reachable, authoritative key set fetched, `kid` genuinely absent.
   - `JwksError` with `isEndpointUnavailable === true` — endpoint unreachable.
   - `JwksRateLimitError` — rate limited.

   Only `SigningKeyNotFoundError` may map to our `KidNotFoundError`, because `handleTeslaCallback`'s degraded path bypasses signature verification and keys off exactly that error. Mapping the others would preserve the silent-downgrade bug.

4. **Repo rule: never use the `any` type.** Define explicit interfaces.

---

## File Structure

**Create:**
- `cmd/next-app/src/lib/tesla-token-endpoint.ts` — owns Tesla `/token` host selection and the form-encoded POST. Single responsibility: getting a token response from whichever host answers.
- `cmd/next-app/src/lib/tesla-token-endpoint.test.ts`

**Modify:**
- `cmd/next-app/src/lib/tesla-auth-service.ts` — JWKS resolution, key lookup, discovery caching, timeouts, code exchange.
- `cmd/next-app/src/lib/tesla-auth-service.test.ts` — one existing test's premise changes (Task 3); new cases added.
- `cmd/next-app/src/lib/tesla-auth.ts` — refresh call.
- `cmd/next-app/src/app/login/route.ts` — authorize URL parameters.
- `cmd/next-app/src/app/login/route.test.ts` — authorize URL assertions.
- `Authentication.md` — document the corrected behavior.

All commands run from `cmd/next-app`.

---

## Task 1: Extract the shared Tesla token endpoint helper

**Files:**
- Create: `cmd/next-app/src/lib/tesla-token-endpoint.ts`
- Test: `cmd/next-app/src/lib/tesla-token-endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/tesla-token-endpoint.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
    TeslaTokenEndpointError,
    postToTeslaTokenEndpoint,
    requireEnv,
} from './tesla-token-endpoint';

const FLEET_AUTH = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const AUTH_TESLA = 'https://auth.tesla.com/oauth2/v3/token';

function okResponse(): Response {
    return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    } as unknown as Response;
}

describe('postToTeslaTokenEndpoint', () => {
    it('posts form-encoded body to the documented fleet-auth host first', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse());

        const { host } = await postToTeslaTokenEndpoint({ grant_type: 'authorization_code' }, fetchImpl);

        expect(host).toBe('https://fleet-auth.prd.vn.cloud.tesla.com');
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(FLEET_AUTH);
        expect((init.headers as Record<string, string>)['Content-Type'])
            .toBe('application/x-www-form-urlencoded');
        expect(String(init.body)).toBe('grant_type=authorization_code');
    });

    it('sets a per-attempt timeout so a blackholed primary host cannot strand the fallback', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse());

        await postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl);

        const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('falls back to auth.tesla.com on a 5xx, resending the identical body', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
            .mockResolvedValueOnce(okResponse());

        const { host } = await postToTeslaTokenEndpoint({ grant_type: 'refresh_token' }, fetchImpl);

        expect(host).toBe('https://auth.tesla.com');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect((fetchImpl.mock.calls[1] as [string, unknown])[0]).toBe(AUTH_TESLA);
        // The reused URLSearchParams body must still carry the parameters on the
        // retry; asserting only the URL would not catch a corrupted second send.
        expect(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body))
            .toBe('grant_type=refresh_token');
    });

    it('falls back to auth.tesla.com when the primary host throws a network error', async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new Error('ECONNRESET'))
            .mockResolvedValueOnce(okResponse());

        const { host } = await postToTeslaTokenEndpoint({ grant_type: 'refresh_token' }, fetchImpl);

        expect(host).toBe('https://auth.tesla.com');
    });

    // Table-driven across the 4xx statuses that matter. The upper bound is the
    // load-bearing part: narrowing the guard to e.g. `status < 429` would make a
    // Tesla rate-limit response trigger a fallback and re-send client_secret to
    // a second origin, which is precisely what this design prevents.
    // tesla-client.ts already handles 429 elsewhere, so that edit is plausible.
    it.each([400, 401, 403, 429])(
        'does NOT fall back on %i, which is a real authentication failure',
        async (status) => {
            const fetchImpl = vi
                .fn()
                .mockResolvedValue({ ok: false, status } as unknown as Response);

            const { response, host } = await postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl);

            expect(response.status).toBe(status);
            expect(host).toBe('https://fleet-auth.prd.vn.cloud.tesla.com');
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
    );

    it('does not re-send the secret to a second host on a 3xx redirect response', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue({ ok: false, status: 302 } as unknown as Response);

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toBeInstanceOf(TeslaTokenEndpointError);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('carries the last HTTP status when every host responds 5xx', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toMatchObject({ name: 'TeslaTokenEndpointError', status: 503 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('reports a null status when every host fails at the network level', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toMatchObject({ name: 'TeslaTokenEndpointError', status: null });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('names the actual failure reason instead of reporting null', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 } as unknown as Response);

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toThrow(/HTTP 502/);
    });

    // ReadableStream.cancel() rejects on an already-errored stream. Without a
    // catch this surfaces as an unhandled rejection, i.e. a 500 where a clean
    // 502 was intended — precisely the flapping-upstream case this branch
    // exists to survive.
    it('does not leak an unhandled rejection when discarding an errored body', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);

        const fetchImpl = vi
            .fn()
            .mockResolvedValue({
                ok: false,
                status: 503,
                body: { cancel: () => Promise.reject(new Error('stream already errored')) },
            } as unknown as Response);

        try {
            await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
                .rejects.toBeInstanceOf(TeslaTokenEndpointError);
            // Give Node a macrotask turn to detect any unhandled rejection.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    // A mixed failure must not report a 5xx status for a network failure, or
    // Task 6 will hand the callback a 503 for what was actually a dead socket.
    it('reports a null status when the last host fails at the network level after a 5xx', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
            .mockRejectedValueOnce(new Error('ECONNRESET'));

        await expect(postToTeslaTokenEndpoint({ code: 'x' }, fetchImpl))
            .rejects.toMatchObject({ status: null });
    });
});

describe('requireEnv', () => {
    it('returns the value when present', () => {
        process.env.PWUSAGE_TEST_ENV = 'present';
        expect(requireEnv('PWUSAGE_TEST_ENV')).toBe('present');
        delete process.env.PWUSAGE_TEST_ENV;
    });

    it('throws by name instead of silently defaulting', () => {
        expect(() => requireEnv('PWUSAGE_DEFINITELY_UNSET_VAR')).toThrow(
            /PWUSAGE_DEFINITELY_UNSET_VAR/
        );
    });

    it('treats a whitespace-only value as missing', () => {
        process.env.PWUSAGE_BLANK_ENV = '   ';
        expect(() => requireEnv('PWUSAGE_BLANK_ENV')).toThrow(/PWUSAGE_BLANK_ENV/);
        delete process.env.PWUSAGE_BLANK_ENV;
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/tesla-token-endpoint.test.ts
```

Expected: FAIL — `Cannot find module './tesla-token-endpoint'`.

- [ ] **Step 3: Write the implementation**

Create `cmd/next-app/src/lib/tesla-token-endpoint.ts`:

```ts
// Tesla's Fleet API documentation states that calls to /token must use the
// fleet-auth host, because server-to-server calls carry different rate limits.
// The OIDC discovery document still declares auth.tesla.com, so Tesla's own
// docs disagree; we try the documented host first and fall back.
//
// Deliberately module-private: exporting it would invite an environment override
// capable of redirecting client_secret to an arbitrary origin.
const TOKEN_ENDPOINT_HOSTS: readonly string[] = [
    'https://fleet-auth.prd.vn.cloud.tesla.com',
    'https://auth.tesla.com',
];

// Without a per-attempt timeout, a TCP blackhole on the primary host hangs until
// the platform kills the function and the fallback never runs — which is the
// exact failure mode (a regional edge outage) the fallback exists for.
const TOKEN_REQUEST_TIMEOUT_MS = 8000;

export class TeslaTokenEndpointError extends Error {
    constructor(message: string, public readonly status: number | null) {
        super(message);
        this.name = 'TeslaTokenEndpointError';
    }
}

function describeError(err: unknown): string {
    if (err instanceof Error) {
        const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
        return `${err.message}${cause}`;
    }
    return String(err);
}

// ReadableStream.cancel() rejects when the stream is already errored, which
// undici can produce mid-read while an upstream is flapping. Without a catch
// that becomes an unhandled rejection — a 500 where a clean 502 was intended.
function discardBody(response: Response): void {
    void response.body?.cancel().catch(() => undefined);
}

/**
 * POST form-encoded parameters to Tesla's /token endpoint, preferring the
 * documented fleet-auth host.
 *
 * Falls back to the secondary host only on transport failures and 5xx. A 4xx is
 * a genuine authentication failure: retrying it elsewhere would mask the real
 * error and re-send our client_secret to a second origin.
 *
 * Throws TeslaTokenEndpointError only when no host produced a usable response.
 * `status` carries the last HTTP status seen, so callers can distinguish an
 * upstream outage (5xx) from a network failure (null).
 */
export async function postToTeslaTokenEndpoint(
    params: Record<string, string>,
    fetchImpl: typeof fetch = fetch
): Promise<{ response: Response; host: string }> {
    const body = new URLSearchParams(params);
    let lastFailure: string | null = null;
    let lastStatus: number | null = null;

    for (const host of TOKEN_ENDPOINT_HOSTS) {
        const url = `${host}/oauth2/v3/token`;

        let response: Response;
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
            });
        } catch (err) {
            // A transport failure is not an HTTP status. Clear any 5xx seen on
            // an earlier host so `status` and the message cannot disagree, and
            // so Task 6 does not report 503 for what was a network failure.
            lastStatus = null;
            lastFailure = `transport error: ${describeError(err)}`;
            console.warn(`[TeslaTokenEndpoint] Transport failure calling ${host}; trying next host: ${lastFailure}`);
            continue;
        }

        if (response.ok) {
            return { response, host };
        }

        // A 4xx is a genuine authentication failure. Retrying it against a
        // second origin would mask the real error and re-send client_secret.
        if (response.status >= 400 && response.status < 500) {
            return { response, host };
        }

        // Any other status (5xx, or an unexpected 1xx/2xx/3xx such as a redirect
        // we did not follow) must not cause the secret to be re-sent elsewhere.
        if (response.status < 500) {
            discardBody(response);
            throw new TeslaTokenEndpointError(
                `Unexpected ${response.status} from ${host}`,
                response.status
            );
        }

        lastStatus = response.status;
        lastFailure = `HTTP ${response.status}`;
        console.warn(`[TeslaTokenEndpoint] ${host} returned ${response.status}; trying next host`);
        discardBody(response);
    }

    throw new TeslaTokenEndpointError(
        `All Tesla token endpoints failed. Last failure: ${lastFailure ?? 'unknown'}`,
        lastStatus
    );
}

/**
 * Read a required environment variable, failing loudly by name.
 *
 * Guards against silently substituting a placeholder credential — the previous
 * refresh implementation defaulted client_id to the literal 'ownerapi', which
 * would have presented our client_secret to the first-party Owner API.
 */
export function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/tesla-token-endpoint.test.ts
```

Expected: PASS, 17 tests (the `it.each` expands to 4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tesla-token-endpoint.ts src/lib/tesla-token-endpoint.test.ts
git commit -m "fix(auth): prefer Tesla's documented fleet-auth /token host with fallback"
```

---

## Task 2: Issuer-aware JWKS fallback URI

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-auth-service.ts:32-67`
- Test: `cmd/next-app/src/lib/tesla-auth-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `describe` block after the existing `describe('getDiscoveryEndpointFromIssuer', ...)` block in `cmd/next-app/src/lib/tesla-auth-service.test.ts`:

```ts
describe('getFallbackJwksUri', () => {
    it('maps the /nts issuer to the third-party key set that actually publishes its kids', async () => {
        const { getFallbackJwksUri } = await import('./tesla-auth-service');
        expect(getFallbackJwksUri('https://auth.tesla.com/oauth2/v3/nts'))
            .toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
    });

    it('maps the base /v3 issuer to its own key set', async () => {
        const { getFallbackJwksUri } = await import('./tesla-auth-service');
        expect(getFallbackJwksUri('https://auth.tesla.com/oauth2/v3'))
            .toBe('https://auth.tesla.com/oauth2/v3/discovery/keys');
    });

    it('defaults an unknown or missing issuer to the third-party set, since Tesla issues /nts tokens', async () => {
        const { getFallbackJwksUri } = await import('./tesla-auth-service');
        expect(getFallbackJwksUri('https://auth.tesla.com/oauth2/v9/unexpected'))
            .toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
        expect(getFallbackJwksUri(undefined))
            .toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
    });

    // Drift guard: adding an issuer to ALLOWED_TESLA_ISSUERS without a mapping
    // here would silently inherit the /nts URI and collide with it.
    //
    // Note this asserts pairwise distinctness, NOT inequality against
    // getFallbackJwksUri(undefined) — /nts is itself the default, so the latter
    // can never hold. Caught in review; do not "simplify" it back.
    it('has an explicit mapping for every allowed Tesla issuer', async () => {
        const { ALLOWED_TESLA_ISSUERS, getFallbackJwksUri } = await import('./tesla-auth-service');
        const uris = ALLOWED_TESLA_ISSUERS.map((issuer) => getFallbackJwksUri(issuer));
        expect(new Set(uris).size).toBe(uris.length);
    });
});

describe('getTeslaJwksUri fallback resolution', () => {
    // The call site is where the original bug lived. Testing only the pure
    // helper would still pass if a future edit bypassed it.
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolves the /nts key set for an /nts token when discovery fails', async () => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        const { getTeslaJwksUri } = await import('./tesla-auth-service');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

        await expect(getTeslaJwksUri('https://auth.tesla.com/oauth2/v3/nts'))
            .resolves.toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
    });

    it('resolves the base key set for a base /v3 token when discovery fails', async () => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        const { getTeslaJwksUri } = await import('./tesla-auth-service');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

        await expect(getTeslaJwksUri('https://auth.tesla.com/oauth2/v3'))
            .resolves.toBe('https://auth.tesla.com/oauth2/v3/discovery/keys');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts -t "getFallbackJwksUri"
```

Expected: FAIL — `getFallbackJwksUri is not a function`.

- [ ] **Step 3: Write the implementation**

In `cmd/next-app/src/lib/tesla-auth-service.ts`, replace the hardcoded fallback at line 66 and add the exported resolver.

Replace lines 63-67:

```ts
    } catch (e) {
        console.error('[TeslaAuthService] OIDC discovery failed:', e);
    }

    console.log('[TeslaAuthService] Using fallback JWKS endpoint: https://auth.tesla.com/oauth2/v3/discovery/keys');
    return 'https://auth.tesla.com/oauth2/v3/discovery/keys';
}
```

with:

```ts
    } catch (e) {
        console.error('[TeslaAuthService] OIDC discovery failed:', e);
    }

    const fallback = getFallbackJwksUri(issuer);
    console.warn('[TeslaAuthService] Discovery did not yield a JWKS URI; using issuer-aware fallback:', fallback);
    return fallback;
}
```

Then insert, immediately after `getDiscoveryEndpointFromIssuer` (after line 29):

```ts
// Each Tesla issuer publishes its own key set (verified 2026-09-30):
//   /nts -> /oauth2/v3/discovery/thirdparty/keys   <- what Tesla actually issues
//   /v3  -> /oauth2/v3/discovery/keys
// A single hardcoded fallback previously resolved the base /v3 set for /nts
// tokens, so any transient discovery failure produced a guaranteed kid miss
// and silently downgraded ID token signature verification.
//
// A Map rather than an object literal: object indexing would return inherited
// members (e.g. 'constructor') for an unrecognised issuer. Unreachable today
// because verifyTeslaIdToken rejects any issuer outside ALLOWED_TESLA_ISSUERS
// before key lookup, but this path is security-critical and cheap to harden.
const NTS_ISSUER = 'https://auth.tesla.com/oauth2/v3/nts';

const FALLBACK_JWKS_URIS = new Map<string, string>([
    [NTS_ISSUER, 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys'],
    ['https://auth.tesla.com/oauth2/v3', 'https://auth.tesla.com/oauth2/v3/discovery/keys'],
]);

export function getFallbackJwksUri(issuer?: string): string {
    const defaultUri = FALLBACK_JWKS_URIS.get(NTS_ISSUER);
    if (!defaultUri) {
        throw new Error(`Missing JWKS fallback for ${NTS_ISSUER}`);
    }
    return (issuer ? FALLBACK_JWKS_URIS.get(issuer) : undefined) ?? defaultUri;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts -t "getFallbackJwksUri"
```

Expected: PASS, 6 tests in this describe block; the file total becomes 28.

- [ ] **Step 5: Run the whole auth service suite to confirm nothing regressed**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tesla-auth-service.ts src/lib/tesla-auth-service.test.ts
git commit -m "fix(auth): resolve the issuer-correct JWKS fallback so /nts tokens find their keys"
```

---

## Task 3: Delete the hand-rolled JWKS refresh and gate the degraded path

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-auth-service.ts:69-180`
- Test: `cmd/next-app/src/lib/tesla-auth-service.test.ts`

**Note:** one existing test changes premise in this task. The test at ~line 929
(`rejects with KidNotFoundError ... when the kid is absent from the JWKS`) mocks
jwks-rsa with a *generic* `Error`. After this task only
`SigningKeyNotFoundError` maps to `KidNotFoundError`, so that mock must be
updated. This is intentional, not a regression.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the end of `cmd/next-app/src/lib/tesla-auth-service.test.ts`:

```ts
describe('JWKS key lookup error mapping', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function verifyWithJwksError(errorName: string): Promise<Error> {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (_kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) => {
                const err = new Error(`simulated ${errorName}`);
                err.name = errorName;
                cb(err);
            }
        } as unknown as ReturnType<typeof jwksClient>);

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ keys: [{ kid: 'other', kty: 'RSA' }] }),
        })));

        const { verifyTeslaIdToken } = await import('./tesla-auth-service');
        const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
        const token = [
            b64url({ alg: 'RS256', kid: 'unknown-kid', typ: 'JWT' }),
            b64url({
                iss: 'https://auth.tesla.com/oauth2/v3/nts',
                aud: 'client-id-123',
                sub: 'sub-123',
                nonce: 'nonce-123',
                exp: Math.floor(Date.now() / 1000) + 3600,
            }),
            Buffer.from('not-a-real-signature').toString('base64url'),
        ].join('.');

        try {
            await verifyTeslaIdToken(token);
            throw new Error('expected verifyTeslaIdToken to reject');
        } catch (err) {
            return err as Error;
        }
    }

    it('maps SigningKeyNotFoundError to KidNotFoundError (key genuinely absent)', async () => {
        const err = await verifyWithJwksError('SigningKeyNotFoundError');
        expect(err.name).toBe('KidNotFoundError');
    });

    it('does NOT map an unreachable-endpoint error to KidNotFoundError, so the degraded signature-bypass path cannot trigger', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const err = await verifyWithJwksError('JwksError');
        // jsonwebtoken re-wraps non-KidNotFoundError key-callback failures in a
        // plain JsonWebTokenError; verifyTeslaIdToken only re-surfaces
        // KidNotFoundError. So assert the security property rather than the
        // error's exact class: handleTeslaCallback treats KidNotFoundError (by
        // instanceof OR by name) as "signature unverifiable" and takes the
        // degraded path that bypasses signature verification. Anything else must
        // not reach that path.
        expect(err).not.toBeInstanceOf(KidNotFoundError);
        expect(err.name).not.toBe('KidNotFoundError');
        // The original cause is still recoverable from the message.
        expect(err.message).toContain('simulated JwksError');
    });

    it('does NOT map a rate-limit error to KidNotFoundError', async () => {
        const { KidNotFoundError } = await import('./tesla-auth-service');
        const err = await verifyWithJwksError('JwksRateLimitError');
        expect(err).not.toBeInstanceOf(KidNotFoundError);
        expect(err.name).not.toBe('KidNotFoundError');
        expect(err.message).toContain('simulated JwksRateLimitError');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts -t "JWKS key lookup error mapping"
```

Expected: FAIL. The 2 security tests fail on their own merits —
`expected 'KidNotFoundError' to be 'JwksError'` — because the old code mapped
*every* error to `KidNotFoundError`. (The Step 1 reset helper only appears in
Step 4, so `__resetJwksClientForTests` may also be reported as missing first;
add the helper, re-run, and confirm the 2 tests then fail on the assertion.)

- [ ] **Step 3: Rewrite the key-lookup implementation**

In `cmd/next-app/src/lib/tesla-auth-service.ts`, delete the `teslaJwksUri` module variable (line 70), delete `fetchFreshJwks` (lines 90-98), delete `logAvailableKeys` (lines 100-108), and replace `getTeslaSigningKeyWithIssuer` (lines 120-180) with:

```ts
function getTeslaSigningKeyWithIssuer(
    header: jwt.JwtHeader,
    issuer: string | undefined,
    callback: jwt.SigningKeyCallback
) {
    getOrCreateJwksClient(issuer)
        .then(
            (client) =>
                new Promise<string>((resolve, reject) => {
                    client.getSigningKey(
                        header.kid,
                        (err: Error | null, key?: { getPublicKey(): string }) => {
                            if (err) {
                                // jwks-rsa memoizes per kid and holds no second-level
                                // key cache, so a miss here means it already refetched
                                // the full JWKS. SigningKeyNotFoundError therefore
                                // means the authoritative key set genuinely lacks this
                                // kid. Any other error (endpoint unreachable, rate
                                // limited) must NOT become KidNotFoundError, because
                                // handleTeslaCallback's degraded path bypasses signature
                                // verification when it sees one.
                                if (err.name === 'SigningKeyNotFoundError') {
                                    reject(new KidNotFoundError(header.kid));
                                    return;
                                }
                                console.error('[TeslaAuthService] JWKS lookup failed without a confirmed missing key', {
                                    kid: header.kid,
                                    errorName: err.name,
                                    message: err.message,
                                });
                                reject(err);
                                return;
                            }
                            if (!key) {
                                reject(new KidNotFoundError(header.kid));
                                return;
                            }
                            resolve(key.getPublicKey());
                        }
                    );
                })
        )
        .then((signingKey) => callback(null, signingKey))
        .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err))));
}
```

- [ ] **Step 4: Add the test-only reset helper**

In `cmd/next-app/src/lib/tesla-auth-service.ts`, insert after the `getOrCreateJwksClient` function:

```ts
/**
 * Reset module-level JWKS and discovery caches.
 *
 * Exported for deterministic tests only; production code has no legitimate use.
 */
export function __resetJwksClientForTests(): void {
    teslaJwksClient = null;
    lastIssuer = null;
}
```

- [ ] **Step 5: Update the existing test whose premise changed**

In `cmd/next-app/src/lib/tesla-auth-service.test.ts`, inside the test
`rejects with KidNotFoundError (not a wrapped JsonWebTokenError) when the kid is absent from the JWKS`
(around line 934), replace the mocked `getSigningKey` so it raises the real
jwks-rsa error name:

```ts
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) => {
                const err = new Error(`Unable to find a signing key that matches '${kid}'`);
                err.name = 'SigningKeyNotFoundError';
                cb(err);
            }
        } as unknown as ReturnType<typeof jwksClient>);
```

The `fetchMock` in that test may keep its `keys` branch; it is now only used for
the discovery call.

- [ ] **Step 6: Run the full auth service suite**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts
```

Expected: PASS, 31 tests (28 + 3).

- [ ] **Step 7: Commit**

```bash
git add src/lib/tesla-auth-service.ts src/lib/tesla-auth-service.test.ts
git commit -m "fix(auth): drop unrated JWKS refetch and gate degraded verification on a confirmed missing key"
```

**Implementation notes (learned while executing — do not re-derive):**

- jwks-rsa v4 throws `SigningKeyNotFoundError` from **two** sites, not one:
  `JwksClient.js:78` ("No KID specified and JWKS endpoint returned more than 1 key")
  and `JwksClient.js:86` ("Unable to find a signing key that matches ..."). Only the
  second means the key set genuinely lacks the kid. The production comment must say
  so; an earlier draft of this plan claimed otherwise and was corrected in review.
  Transport failures surface as `JwksError` with `isEndpointUnavailable`, never as
  `SigningKeyNotFoundError`, so the split is sound.
- The string comparison `err.name === 'SigningKeyNotFoundError'` is deliberate and
  should be kept: it matches jwks-rsa's own `express.js`/`hapi.js`/`passport.js`
  integrations, and `instanceof` would fight the suite's `vi.mock('jwks-rsa')`
  automock at `tesla-auth-service.test.ts:8`.
- **Test isolation:** reset the module-level JWKS client in the `afterEach` of the
  block that *creates* residue (the `JWKS key lookup error mapping` describe), not
  only the block whose test is at risk. Resetting only `verifyTeslaIdToken` leaves
  the order dependency in place — confirmed empirically: a test appended after the
  mapping block ran against the wrong stub and failed. Both blocks now reset.
- The `!key` -> `KidNotFoundError` branch is unreachable (`getSigningKey` is `async`
  and always resolves or throws; `callbackify` cannot yield `(null, undefined)`).
  Left as-is deliberately.

---

## Task 4: Harden the jwks-rsa client and cache discovery per issuer

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-auth-service.ts:31-88`
- Test: `cmd/next-app/src/lib/tesla-auth-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `cmd/next-app/src/lib/tesla-auth-service.test.ts`:

```ts
describe('jwks client configuration', () => {
    // These blocks live at the top level, outside `describe('TeslaAuthService')`,
    // so they do not inherit that block's beforeEach. Reset mock call history
    // explicitly or `mock.calls[0]` below may refer to an earlier test.
    beforeEach(() => {
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('opts into stale-key availability with observability, and sets explicit rate limit and timeout', async () => {
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (_kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) =>
                cb(new Error('unused')),
        } as unknown as ReturnType<typeof jwksClient>);

        vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => ({
            ok: true,
            status: 200,
            json: async () => String(url).includes('openid-configuration')
                ? {
                    issuer: 'https://auth.tesla.com/oauth2/v3/nts',
                    jwks_uri: 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys',
                }
                : { keys: [] },
        })));

        const { verifyTeslaIdToken } = await import('./tesla-auth-service');
        const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
        const token = [
            b64url({ alg: 'RS256', kid: 'k', typ: 'JWT' }),
            b64url({
                iss: 'https://auth.tesla.com/oauth2/v3/nts',
                aud: 'client-id-123',
                sub: 's',
                nonce: 'n',
                exp: Math.floor(Date.now() / 1000) + 3600,
            }),
            Buffer.from('sig').toString('base64url'),
        ].join('.');
        await verifyTeslaIdToken(token).catch(() => undefined);

        const options = vi.mocked(jwksClient).mock.calls[0][0] as Record<string, unknown>;
        expect(options.jwksUri).toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
        expect(options.cache).toBe(true);
        expect(options.cacheMaxAgeFallback).toBeGreaterThan(0);
        expect(typeof options.onStaleCacheFallback).toBe('function');
        expect(options.rateLimit).toBe(true);
        expect(options.jwksRequestsPerMinute).toBe(10);
        expect(options.timeout).toBeGreaterThan(0);
    });

    it('caches discovery per issuer so steady-state logins skip the round-trip', async () => {
        const { __resetJwksClientForTests } = await import('./tesla-auth-service');
        __resetJwksClientForTests();

        const jwksClient = (await import('jwks-rsa')).default;
        vi.mocked(jwksClient).mockReturnValue({
            getSigningKey: (_kid: string | null | undefined, cb: (err: Error | null, key?: unknown) => void) =>
                cb(new Error('unused')),
        } as unknown as ReturnType<typeof jwksClient>);

        const discoveryFetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                issuer: 'https://auth.tesla.com/oauth2/v3/nts',
                jwks_uri: 'https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys',
            }),
        }));
        vi.stubGlobal('fetch', discoveryFetch);

        const { getTeslaJwksUri } = await import('./tesla-auth-service');
        const first = await getTeslaJwksUri('https://auth.tesla.com/oauth2/v3/nts');
        const second = await getTeslaJwksUri('https://auth.tesla.com/oauth2/v3/nts');

        expect(first).toBe('https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys');
        expect(second).toBe(first);
        expect(discoveryFetch).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts -t "jwks client configuration"
```

Expected: FAIL — `cacheMaxAgeFallback` is not configured on the jwks client, and
a second call re-fetches discovery because nothing is cached yet.

- [ ] **Step 3: Implement discovery caching**

In `cmd/next-app/src/lib/tesla-auth-service.ts`, replace `getTeslaJwksUri` (lines 32-67) with:

```ts
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DISCOVERY_TIMEOUT_MS = 5000;

const discoveryCache = new Map<string, { uri: string; fetchedAt: number }>();

// Discover the correct JWKS endpoint from OpenID Connect discovery, cached per
// issuer so steady-state logins avoid a network round-trip before the JWKS
// fetch. Cold-path timeouts live here and on the jwks client, not wrapped
// around the whole verification: a warm cache hit performs no network I/O and
// therefore cannot hang.
export async function getTeslaJwksUri(issuer?: string): Promise<string> {
    const cacheKey = issuer ?? 'default';
    const cached = discoveryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
        return cached.uri;
    }

    let discoveryUrl = 'https://auth.tesla.com/oauth2/v3/.well-known/openid-configuration';
    const discoveryFromIssuer = issuer ? getDiscoveryEndpointFromIssuer(issuer) : null;
    if (discoveryFromIssuer) {
        discoveryUrl = discoveryFromIssuer;
    }

    try {
        const response = await fetch(discoveryUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });

        if (response.ok) {
            const config = await response.json();
            if (typeof config?.jwks_uri === 'string') {
                discoveryCache.set(cacheKey, { uri: config.jwks_uri, fetchedAt: Date.now() });
                return config.jwks_uri;
            }
        } else {
            console.error('[TeslaAuthService] OIDC discovery failed with status', response.status);
        }
    } catch (e) {
        console.error('[TeslaAuthService] OIDC discovery failed:', e);
    }

    // Discovery failed. Prefer a previously cached URI over any fallback, so a
    // transient failure does not downgrade us to a possibly different key set.
    if (cached) {
        console.warn('[TeslaAuthService] Discovery failed; reusing cached JWKS URI', cached.uri);
        return cached.uri;
    }

    const fallback = getFallbackJwksUri(issuer);
    console.warn('[TeslaAuthService] Discovery unavailable; using issuer-aware fallback:', fallback);
    return fallback;
}

```

Extend `__resetJwksClientForTests` to also clear the discovery cache:

```ts
export function __resetJwksClientForTests(): void {
    teslaJwksClient = null;
    lastIssuer = null;
    discoveryCache.clear();
}
```

- [ ] **Step 4: Configure the jwks client**

Replace `getOrCreateJwksClient` (lines 73-88) with:

```ts
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
// Availability vs security trade, documented upstream: when the JWKS endpoint
// is unreachable and cacheMaxAge has expired, keep serving the last known good
// key for this additional window instead of failing every login. The cost is
// that a rotated-and-compromised key stays trusted for up to this long. Sized
// to Tesla's expected JWKS recovery time; onStaleCacheFallback makes every use
// observable so a long outage cannot pass silently.
const JWKS_STALE_FALLBACK_MS = 60 * 60 * 1000;
const JWKS_REQUEST_TIMEOUT_MS = 5000;
const JWKS_REQUESTS_PER_MINUTE = 10;

async function getOrCreateJwksClient(issuer?: string) {
    if (!teslaJwksClient || (issuer && issuer !== lastIssuer)) {
        lastIssuer = issuer || null;
        const jwksUri = await getTeslaJwksUri(issuer);
        teslaJwksClient = jwksClient({
            jwksUri,
            cache: true,
            cacheMaxEntries: 10,
            cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
            cacheMaxAgeFallback: JWKS_STALE_FALLBACK_MS,
            onStaleCacheFallback: (err: Error, kid: string | null | undefined) => {
                console.warn('[TeslaAuthService] Serving stale JWKS key; Tesla JWKS endpoint is unavailable', {
                    kid,
                    endpointError: err.message,
                });
            },
            rateLimit: true,
            jwksRequestsPerMinute: JWKS_REQUESTS_PER_MINUTE,
            timeout: JWKS_REQUEST_TIMEOUT_MS,
        });
    }
    return teslaJwksClient;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tesla-auth-service.ts src/lib/tesla-auth-service.test.ts
git commit -m "fix(auth): cache OIDC discovery and configure JWKS caching, staleness and rate limits"
```

**Implementation notes (learned while executing — do not re-derive):**

- The effective stale window is `cacheMaxAge + cacheMaxAgeFallback` = **70 minutes**,
  measured from the last *successful* fetch (`node_modules/jwks-rsa/src/wrappers/cache.js:33`).
  The 60-minute constant alone understates it. Any comment quantifying this exposure
  must state 70.
- `onStaleCacheFallback` fires only when `err.isEndpointUnavailable` is set, which happens
  only in `JwksClient.getKeys()`'s catch. A kid miss or a rate limit does **not** trigger
  stale serving, so rate limiting cannot be masked as "stale". Depends on this staying true.
- **In production, discovery and the hardcoded fallback always agree** for both allowed
  issuers — `FALLBACK_JWKS_URIS` matches what Tesla's discovery documents publish. So the
  "prefer a cached URI over the fallback" branch is purely defensive against Tesla
  changing one and not the other. Its test therefore only works because the stub
  deliberately resolves discovery to the *other* key set. **Do not "fix" that stub into
  realism** — it would silently gut the test.
- `JWKS_REQUEST_TIMEOUT_MS = 5000` (vs jwks-rsa's 30000 default) is largely belt-and-braces:
  the 3s route race in `handleTeslaCallback` already caps user-visible latency. It bounds a
  background socket left dangling when that race rejects. It is not a tuned latency figure.
- `JWKS_REQUESTS_PER_MINUTE = 10` equals the library default. Kept deliberately as a
  tripwire: an explicit pin plus a test catches a silent default change. The comment
  states plainly that it is a no-op today.
- The discovery cache's headline benefit is **not** avoiding a round-trip — `getOrCreateJwksClient`
  never re-asks while the client is warm and the issuer is unchanged, so the TTL is inert in
  the common case. Its real value is the stale-URI-reuse branch. Lead with that when explaining it.
- Full jwks-rsa dependency table now lives in `DesignDecisions.md` section 5, including the
  Task 3 inversion risk: if jwks-rsa ever reported an outage as `SigningKeyNotFoundError`,
  the signature bypass would reopen.

---

## Task 5: Remove the blanket 3-second verification race

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-auth-service.ts:307-334`

**Rationale:** the race wrapped the entire verification — including a discovery
fetch and a JWKS fetch — in 3 seconds, and on expiry threw a plain `Error` that
`handleTeslaCallback` reported as `invalid-id-token`. Timeouts now live on the
individual HTTP requests (Task 4), so a warm cache hit cannot hang and a cold
path fails at the network layer with an accurate error.

- [ ] **Step 1: Write the failing test**

This test is deliberately slow (~3.2s). It is the only honest way to prove the
race is gone: with the old code the verification is cut off at 3 seconds and the
login fails, so a delay just past that threshold distinguishes the two behaviors.
Vitest's default 5s timeout accommodates it. Do not "optimize" this by lowering
the delay — it would pass under both implementations and prove nothing.

Insert this block **inside** the existing `describe('TeslaAuthService', ...)`,
immediately before its closing `});`. It reuses that block's `mockUserRepo`,
`mockSiteRepo`, `mockTeslaTokenRepo`, `mockTeslaClient` fixtures and its
`beforeEach`, none of which are in scope at the top level of the file.

```ts
describe('ID token verification is not cut off by an outer timeout race', () => {
    it('completes a verification that takes longer than the old 3s threshold', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'id_token_xyz',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600,
        });

        // 3.2s: past the removed 3s race, comfortably inside Vitest's 5s default.
        const verifyIdToken = vi.fn().mockImplementation(
            () => new Promise((resolve) => setTimeout(
                () => resolve({ nonce: 'good-nonce', sub: 'sub-123', email: 'user@example.com' }),
                3200
            ))
        );

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 98765, resource_type: 'battery', site_name: 'Home Powerwall' },
        ]);
        mockUserRepo.getByEmail.mockResolvedValue(null);
        mockUserRepo.getById.mockResolvedValue({ id: 'sub-123', roles: [] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            tokenExchange,
            verifyIdToken,
        });

        const result = await service.handleTeslaCallback({
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result.status).toBe('success');
    }, 10000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts -t "not cut off by an outer timeout race"
```

Expected: FAIL with `invalid-id-token` — the 3s race fires first and its
`Verification timeout` error is not a `KidNotFoundError`, so the callback fails
closed.

- [ ] **Step 3: Remove the race**

In `cmd/next-app/src/lib/tesla-auth-service.ts`, replace lines 310-328:

```ts
        try {
            if (this.deps.verifyIdToken) {
                decoded = await this.deps.verifyIdToken(authData.id_token);
                signatureVerified = true;
            } else {
                // Wrap default verify with a 3-second timeout
                let timeoutId: NodeJS.Timeout | undefined;
                try {
                    const verificationPromise = verifyTeslaIdToken(authData.id_token);
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('Verification timeout')), 3000);
                    });
                    decoded = await Promise.race([verificationPromise, timeoutPromise]);
                    signatureVerified = true;
                    console.log('[TeslaAuthService] ID Token signature verified successfully');
                } finally {
                    if (timeoutId) clearTimeout(timeoutId);
                }
            }
        } catch (err) {
```

with:

```ts
        try {
            if (this.deps.verifyIdToken) {
                decoded = await this.deps.verifyIdToken(authData.id_token);
                signatureVerified = true;
            } else {
                // No outer timeout race here. Network timeouts are enforced on
                // the discovery and JWKS requests themselves, so a warm cache hit
                // (which does no network I/O) cannot hang, and a genuine slow
                // response surfaces as a JWKS error rather than being mislabeled
                // as an invalid token.
                decoded = await verifyTeslaIdToken(authData.id_token);
                signatureVerified = true;
                console.log('[TeslaAuthService] ID Token signature verified successfully');
            }
        } catch (err) {
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tesla-auth-service.ts src/lib/tesla-auth-service.test.ts
git commit -m "fix(auth): enforce timeouts at the HTTP layer instead of racing whole verification"
```

**Implementation notes (learned while executing — do not re-derive):**

- **Third plan bug:** the spec's test injected a `verifyIdToken` dep, which takes the
  `if` branch — the one that was *never* raced. It passed against unmodified code. A test
  that injects a slow `verifyIdToken` and expects it to be slow will pass with or without
  the race. To exercise the real path you must control the network layer instead.
- A hand-built unsigned token cannot test this: it fails signature verification regardless
  of timing, so it cannot distinguish slow-network from bad-token. The test generates a
  real RS256 keypair, signs a genuine token, and serves the matching public key.
- The test uses **fake timers** (idiomatic here — `tesla-client.test.ts` already does).
  Real timers cost 3.4s of wall clock and left a ~1.6s flake window between the removed
  3s race and `DISCOVERY_TIMEOUT_MS`. `AbortSignal.timeout` is **not** faked by sinon, so
  the flake window is closed structurally rather than by margin.
- Under fake timers, `expect(discoveryFetchSettled).toBe(true)` became **vacuous** — both
  the race timer and the fetch timer fall in the same advance window. Replaced with a
  mid-flight check at 3100ms asserting verification is *still in flight* past 3s, which is
  a stronger positive assertion and does not reference the old implementation.
- Never put an `expect` inside an `afterEach` drain. When the test fails, the drain's
  failure is reported second and **masks** the real one, sending the next debugger after
  the wrong error. Use a non-asserting poll.
- Removing the race means verification has a **~10s worst case** (5s discovery + 5s JWKS,
  which stack because `getOrCreateJwksClient` awaits discovery first). Fine against the
  route's `maxDuration = 60`.
- Note jwks-rsa's `timeout` is an **idle-socket** timeout, not a total-request timeout.
- Latent regression trap: all three original assertions also held on the
  `KidNotFoundError` **signature-bypassing** path. Assert on the
  `Authentication: signature verified + nonce validated` log line to pin the real path.
- Rationale and guardrails are recorded in `DesignDecisions.md` section 5,
  "Verification timeout ownership" — not in a test comment, where they would drift.

---

## Task 6: Route the authorization code exchange through the shared helper

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-auth-service.ts:280-305`

- [ ] **Step 1: Write the failing tests**

Insert this block **inside** the existing `describe('TeslaAuthService', ...)`,
immediately before its closing `});`, for the same scoping reason as Task 5. It
inherits that block's `beforeEach`, so remove the local `afterEach` if it
duplicates an existing one.

```ts
describe('authorization code exchange', () => {
    // postToTeslaTokenEndpoint reads these via requireEnv. The file's outer
    // beforeEach only sets PUBLIC_TESLA_OAUTH_CLIENT_ID, so without these the
    // helper throws a plain Error (NOT TeslaTokenEndpointError), the new catch
    // rethrows it, and these tests fail with an unhandled throw.
    // Nested describes in this file set their own env, so keep it local.
    beforeEach(() => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        process.env.TESLA_OAUTH_SECRET = 'secret-123';
        process.env.PUBLIC_TESLA_OAUTH_AUDIENCE = 'audience-123';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends the code exchange to the documented fleet-auth host', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ error: 'invalid_auth_code' }),
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        await service.handleTeslaCallback({
            code: 'bad-code',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        const requestedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(requestedUrls).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
        ]);
    });

    it('never falls back to a second host for a 4xx rejection', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: 'unauthorized_client' }),
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        const result = await service.handleTeslaCallback({
            code: 'bad',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result.status).toBe('token-exchange-failed');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to auth.tesla.com when the primary host returns 5xx', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    id_token: 'id_token_xyz',
                    access_token: 'access_123',
                    refresh_token: 'refresh_123',
                    expires_in: 3600,
                }),
            } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        // Do NOT inject `tokenExchange` here. The service prefers
        // deps.tokenExchange over the real helper (tesla-auth-service.ts:387),
        // so injecting it bypasses postToTeslaTokenEndpoint entirely and fetch
        // is never called for the exchange - `urls[0]` would be undefined.
        // Inject only verifyIdToken, so the rest of the callback does not
        // attempt real JWKS work.
        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 98765, resource_type: 'battery', site_name: 'Home Powerwall' },
        ]);
        mockUserRepo.getByEmail.mockResolvedValue(null);
        mockUserRepo.getById.mockResolvedValue({ id: 'sub-123', roles: [] });

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            verifyIdToken: vi.fn().mockResolvedValue({
                nonce: 'good-nonce',
                sub: 'sub-123',
                email: 'user@example.com',
            }),
        });

        await service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback',
        });

        // Assert the exact ordered sequence, not just that the primary was
        // tried: this is what proves the fallback to the secondary host
        // actually occurred after a 5xx. `toBeGreaterThan(0)` on its own
        // would pass even if only one URL had been requested.
        const urls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(urls).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
            'https://auth.tesla.com/oauth2/v3/token',
        ]);
    });

    // Regression guard: when every host 5xxs, postToTeslaTokenEndpoint throws.
    // If handleTeslaCallback lets that escape, route.ts rethrows it on the web
    // path and the user gets a raw 500 instead of the 503 they get today.
    it('reports token-exchange-failed with the upstream status when every host 5xxs', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
        } as unknown as Response));

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        const result = await service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result).toEqual({ status: 'token-exchange-failed', statusCode: 503 });
    });

    // requireEnv throws a plain Error, which is not a TeslaTokenEndpointError,
    // so it is deliberately NOT swallowed: a missing client_secret is a
    // deployment misconfiguration and should fail loudly rather than surface as
    // a user-facing token-exchange failure. Critically, it must never reach the
    // wire - the old `process.env.TESLA_OAUTH_SECRET!` non-null assertion would
    // have posted the literal string "undefined" as the client_secret.
    it('never sends a request when the client secret is missing', async () => {
        delete process.env.TESLA_OAUTH_SECRET;
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        await expect(service.handleTeslaCallback({
            code: 'code',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        })).rejects.toThrow(/TESLA_OAUTH_SECRET/);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    // A 4xx is returned, not thrown, so it must still map to a 4xx passthrough.
    it('passes a 4xx straight through without consulting the fallback host', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        const { TeslaAuthService } = await import('./tesla-auth-service');
        const service = new TeslaAuthService();

        const result = await service.handleTeslaCallback({
            code: 'bad',
            state: 's',
            savedState: 's',
            savedNonce: 'n',
            callbackUrl: 'http://localhost/callback',
        });

        expect(result).toEqual({ status: 'token-exchange-failed', statusCode: 400 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
```

**Expect only 3 of these 6 tests to be red before implementation.** The other three
(`never falls back to a second host for a 4xx rejection`, `reports token-exchange-failed
with the upstream status when every host 5xxs`, and `passes a 4xx straight through`) are
**regression guards**: they pin behavior the refactor must preserve, so pre- and
post-implementation behavior is identical and green-then-green is the only possible
outcome. They are not evidence of the change, and they are not vacuous either - each is
proven to bite by a mutation. Do not manufacture a red for them. The full host-fallback
policy itself is covered directly in `tesla-token-endpoint.test.ts`.

The three genuine reds are: the host assertion, the two-URL fallback sequence, and the
missing-secret test. The last is worth reading closely - its pre-implementation failure is
`Cannot read properties of undefined (reading 'ok')`, because the mock returns `undefined`
and the only code that reads `.ok` off it is the code that actually sent the request. That
is the old `process.env.TESLA_OAUTH_SECRET!` bug made visible: it shipped the literal
string `"undefined"` as the client_secret.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts -t "authorization code exchange"
```

Expected: the first test FAILS — the only URL requested today is
`https://auth.tesla.com/oauth2/v3/token`, not the `fleet-auth` host.

- [ ] **Step 3: Implement the swap**

Add to the imports at the top of `cmd/next-app/src/lib/tesla-auth-service.ts`:

```ts
import {
    TeslaTokenEndpointError,
    postToTeslaTokenEndpoint,
    requireEnv,
} from './tesla-token-endpoint';
```

Replace lines 284-298:

```ts
        } else {
            const tokenResponse = await fetch("https://auth.tesla.com/oauth2/v3/token", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    client_id: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID!,
                    client_secret: process.env.TESLA_OAUTH_SECRET!,
                    audience: process.env.PUBLIC_TESLA_OAUTH_AUDIENCE!,
                    redirect_uri: callbackUrl,
                    grant_type: "authorization_code",
                    code: code,
                }),
            });
```

with:

```ts
        } else {
            let tokenResponse: Response;
            try {
                // Tesla documents fleet-auth as the required host for
                // server-to-server /token calls; see tesla-token-endpoint.ts
                // for the fallback policy.
                const exchange = await postToTeslaTokenEndpoint({
                    client_id: requireEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID'),
                    client_secret: requireEnv('TESLA_OAUTH_SECRET'),
                    audience: requireEnv('PUBLIC_TESLA_OAUTH_AUDIENCE'),
                    redirect_uri: callbackUrl,
                    grant_type: 'authorization_code',
                    code,
                });
                tokenResponse = exchange.response;
            } catch (err) {
                // Every Tesla host failed. Without this catch the error escapes
                // handleTeslaCallback, and src/app/auth/tesla-callback/route.ts
                // rethrows it on the web path — converting today's clean 503
                // token-exchange-failed response into a raw 500.
                if (!(err instanceof TeslaTokenEndpointError)) throw err;
                console.error('[TeslaAuthService] Token exchange failed on all hosts:', err.message);
                // Clamp: an unexpected non-error status (e.g. a 3xx surfaced by
                // postToTeslaTokenEndpoint) must not become an HTTP status on
                // our own response.
                const upstreamStatus = err.status && err.status >= 400 ? err.status : 502;
                return { status: 'token-exchange-failed', statusCode: upstreamStatus };
            }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/lib/tesla-auth-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tesla-auth-service.ts src/lib/tesla-auth-service.test.ts
git commit -m "fix(auth): send the code exchange to Tesla's documented token host"
```

**Implementation notes (learned while executing - do not re-derive):**

- Two more plan bugs, both of the Task 5 family (a test that bypasses the code it
  claims to exercise):
  1. The new `describe` set no env. `requireEnv` throws a plain `Error`, which the new
     `catch` rethrows because it is not a `TeslaTokenEndpointError` - so four of the five
     planned tests failed with an unhandled throw rather than returning a status.
  2. The fallback test injected `tokenExchange`. The service prefers `deps.tokenExchange`
     over the real helper, so `postToTeslaTokenEndpoint` never ran and `fetch` was never
     called for the exchange; `expect(urls[0])` read `undefined`.
- Its original assertion (`urls[0]` is the primary, plus `length > 0`) would also have
  passed **without** any fallback happening. Assert the exact ordered two-URL sequence.
- Behaviour change worth stating plainly: a missing `TESLA_OAUTH_SECRET` now throws
  instead of producing a 4xx. Deliberate - the old `process.env.X!` assertion posted the
  literal string `"undefined"` as the client_secret, so this is a small hardening win.
  It means a misconfigured deploy yields a loud throw instead of a clean user-facing
  status; `route.ts` rethrows unknown errors, so that surfaces as a 500.
- The code-quality review then found `route.ts` validated two of the three env vars the
  service now requires, so that throw reached users as a raw Next 500 instead of the
  route's existing `{error: 'Server misconfigured'}` JSON. Adding `TESLA_OAUTH_SECRET`
  to that check resolves it in three tokens and keeps the throw semantics. **Lesson: when
  a change introduces a new required-env throw, check whether the route's existing
  validation already covers it.**
- **Credential exposure found by review, not by this task:** the helper followed
  redirects, so a 307/308 from `fleet-auth` would make undici re-POST the body -
  `client_secret` included - to the redirect target. Pre-existing (the hand-rolled fetch
  had identical exposure) and it needs a compromised or MITM'd Tesla endpoint, but it was
  closed with `redirect: 'manual'`. Verified **empirically** against a real local server,
  not reasoned about: with default handling the redirect target received
  `client_secret=SUPER-SECRET`; with `manual` it received zero requests.
- That fix is only **partially** unit-testable: a mocked `fetch` never follows or refuses
  a redirect, and the endpoint hosts are a module-private constant with no override, so a
  test cannot point the helper at a real server. The committed test pins the *request
  option* and its comment states the limitation. Do not read it as end-to-end proof.
- `redirect: 'manual'` changed the clamp from dead code to load-bearing: a real 3xx now
  reaches the throw path rather than being auto-followed. Extracted `toUpstreamStatus()`
  so both the throw path and the `!response.ok` path share one clamp, and added a test
  proving a 3xx reports 502 rather than echoing an upstream redirect status.
- Nothing asserted the **posted form body**, even though this task rewrote all six
  params. A dropped `redirect_uri` would have shipped green and broken every login.
  Assert it via `Object.fromEntries(new URLSearchParams(body))` - exact equality catches
  both a dropped and an *extra* param.

---

## Task 7: Fix the refresh token request

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-auth.ts:1-33`
- Test: `cmd/next-app/src/lib/tesla-auth.test.ts` (create)

- [ ] **Step 1: Check every caller before changing the signature**

```bash
grep -rn "refreshAccessToken" src/ scripts/ 2>/dev/null
```

Record the list. The exported signature stays the same, so no callers should
need edits. If any caller relies on the old `'ownerapi'` default, note it in the
commit body.

- [ ] **Step 2: Write the failing test**

Create `cmd/next-app/src/lib/tesla-auth.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAccessToken } from './tesla-auth';
import { TeslaAuthError } from './tesla-client';

describe('refreshAccessToken', () => {
    beforeEach(() => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        process.env.TESLA_OAUTH_SECRET = 'secret-123';
        process.env.PUBLIC_TESLA_OAUTH_AUDIENCE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a form-encoded refresh request including audience', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }),
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        const result = await refreshAccessToken('old-refresh');

        expect(result).toEqual({ access_token: 'new-access', refresh_token: 'new-refresh' });

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token');
        expect((init.headers as Record<string, string>)['Content-Type'])
            .toBe('application/x-www-form-urlencoded');

        const params = new URLSearchParams(String(init.body));
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('client_id')).toBe('client-id-123');
        expect(params.get('audience')).toBe('https://fleet-api.prd.na.vn.cloud.tesla.com');
        expect(params.get('refresh_token')).toBe('old-refresh');
    });

    it('never sends the first-party ownerapi client id when the env var is unset', async () => {
        delete process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(refreshAccessToken('old-refresh')).rejects.toThrow(
            /PUBLIC_TESLA_OAUTH_CLIENT_ID/
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('raises TeslaAuthError on login_required so the caller can revoke', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => '{"error":"login_required"}',
        } as unknown as Response));

        await expect(refreshAccessToken('old-refresh')).rejects.toBeInstanceOf(TeslaAuthError);
    });

    it('falls back to auth.tesla.com when the primary host returns 5xx', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 502 } as unknown as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ access_token: 'a', refresh_token: 'r' }),
            } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        const result = await refreshAccessToken('old-refresh');

        expect(result.access_token).toBe('a');
        const urls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(urls).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
            'https://auth.tesla.com/oauth2/v3/token',
        ]);
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run src/lib/tesla-auth.test.ts
```

Expected: FAIL — body is JSON, `audience` is absent, and the `ownerapi` default
means the unset-env test resolves instead of throwing.

- [ ] **Step 4: Implement the fix**

Replace the entire contents of `cmd/next-app/src/lib/tesla-auth.ts`:

```ts
import { TeslaAuthError } from './tesla-client';
import { postToTeslaTokenEndpoint, requireEnv } from './tesla-token-endpoint';

// Tesla requires `audience` on token requests and documents form encoding for
// server-to-server calls. The previous implementation sent JSON, omitted
// audience, and defaulted client_id to the literal 'ownerapi', which would have
// presented our client_secret to the first-party Owner API if the environment
// variable were ever missing.
const REFRESH_SCOPE = 'openid email offline_access';

export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token: string }> {
    const { response } = await postToTeslaTokenEndpoint({
        grant_type: 'refresh_token',
        client_id: requireEnv('PUBLIC_TESLA_OAUTH_CLIENT_ID'),
        client_secret: requireEnv('TESLA_OAUTH_SECRET'),
        audience: requireEnv('PUBLIC_TESLA_OAUTH_AUDIENCE'),
        refresh_token: refreshToken,
        scope: REFRESH_SCOPE,
    });

    if (!response.ok) {
        const body = await response.text();
        const message = `Failed to refresh token: ${response.status} ${body}`;
        if (
            response.status === 401 ||
            (response.status === 400 && (body.includes('invalid_grant') || body.includes('login_required')))
        ) {
            throw new TeslaAuthError(message, response.status);
        }
        throw new Error(message);
    }

    return response.json();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/lib/tesla-auth.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Run the full suite**

```bash
npx vitest run
```

Expected: PASS. Use `npx vitest run`, **not** `npm test` — the package.json
`test` script is bare `vitest`, which runs in watch mode and will hang a
non-interactive agent.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tesla-auth.ts src/lib/tesla-auth.test.ts
git commit -m "fix(auth): send form-encoded refresh requests with audience and no ownerapi default"
```

**Implementation notes (learned while executing - do not re-derive):**

- **Error type change on the all-hosts-5xx path.** `refreshAccessToken` now throws
  `TeslaTokenEndpointError("All Tesla token endpoints failed. Last failure: HTTP 503")`
  instead of `Error("Failed to refresh token: 503 ...")`, because both hosts are now tried.
  Neither error matches `isTeslaAuthError`, so `TeslaTokenRepo` still releases the refresh
  lock without revoking, and `tesla-client.ts` still logs and falls through to the
  original 401. Safe, but caller-visible: **later tasks must not assert on the old error
  string**, and a test that diffs against `"Failed to refresh token: 503"` needs updating.
  Pinned by `surfaces a terminal token-endpoint failure when every host 5xxs`.
- **The `isTeslaAuthError` substring hazard is the load-bearing part of that change** and
  is recorded in `DesignDecisions.md` section 5 ("Terminal vs transient failures"). Short
  version: `isTeslaAuthError` matches message *substrings* `login_required` /
  `invalid_grant`, not just error types, so `parseRefreshedTokens` throws a plain `Error`
  whose message contains neither. A `TeslaAuthError` there - or a plain `Error` that echoes
  upstream text verbatim - would make `TeslaTokenRepo` flip the user to `revoked` +
  `is_active = false` off a malformed 200. Both facts are pinned by
  `throws a plain, non-terminal error when a 200 response omits the tokens`.
- **`Response.json()` is typed `any`.** The plan's `return response.json();` satisfied the
  declared return type without any check, so a malformed 200 would reach `updateSiteTokens`
  as `undefined`. `parseRefreshedTokens(payload: unknown)` erases the `any` at the boundary
  (an `unknown` parameter accepts it without propagating it) and narrows both fields.
- A missing `PUBLIC_TESLA_OAUTH_AUDIENCE` now throws **before** any request is sent - the
  old code silently posted a request Tesla rejects. It is **non-terminal**, because
  `requireEnv` throws a plain `Error`: the refresh lock is released and the user is *not*
  revoked. That is the right outcome for a deployment misconfiguration (one alert, no mass
  de-authentication). Same reasoning for the newly guarded `TESLA_OAUTH_SECRET` on this
  path, which previously posted the literal string `"undefined"` as `client_secret`.
- Only **3 of the plan's 4** tests were red by construction. `raises TeslaAuthError on
  login_required` already passed against the unmodified file - the old code already checked
  `body.includes('login_required')` - so it is a regression guard, not evidence of the
  change. Do not manufacture a red for it.
- Pin the **whole** body, as Task 6 concluded: `Object.fromEntries(new URLSearchParams(body))`
  with exact equality, not four `params.get()` calls. Confirmed by mutation - dropping
  `audience` fails only the exact-equality assertion.
- All four mutations were caught: restoring `|| 'ownerapi'` fails the client-id test;
  `JSON.stringify` in the helper fails the body assertion; dropping `audience` fails two
  tests; bypassing the helper for a single `auth.tesla.com` POST fails four.

---

## Task 8: Correct the authorize URL parameters

**Files:**
- Modify: `cmd/next-app/src/app/login/route.ts:42-49`
- Test: `cmd/next-app/src/app/login/route.test.ts`

**Why `encodeURIComponent` and not `URLSearchParams`:** `URLSearchParams.toString()`
encodes spaces as `+`. `encodeURIComponent` produces `%20`, matching the current
behavior and the format in Tesla's own documentation. Step 3 verifies Tesla
accepts the encoding we emit before we rely on it.

- [ ] **Step 1: Write the failing tests**

Add the import at the top of `cmd/next-app/src/app/login/route.test.ts`:

```ts
import { buildTeslaAuthorizeUrl } from './route';
```

Then append:

```ts
describe('buildTeslaAuthorizeUrl', () => {
    const baseParams = {
        state: 'state-123',
        nonce: 'nonce-456',
        callbackUrl: 'https://pwusage.fm.rodeo/auth/tesla-callback',
        clientId: 'client-id-123',
    };

    it('requests missing scopes with prompt_missing_scopes', () => {
        expect(buildTeslaAuthorizeUrl(baseParams)).toContain('prompt_missing_scopes=true');
    });

    it('does not force prompt=login, which re-authenticates on every login', () => {
        expect(buildTeslaAuthorizeUrl(baseParams)).not.toContain('prompt=login');
    });

    it('percent-encodes scope separators rather than using +', () => {
        const url = buildTeslaAuthorizeUrl(baseParams);
        expect(url).toContain('scope=openid%20energy_device_data%20offline_access');
        expect(url).not.toContain('+');
    });

    it('omits the stray double separator and carries every required parameter', () => {
        const url = buildTeslaAuthorizeUrl(baseParams);
        expect(url).toMatch(/^https:\/\/auth\.tesla\.com\/oauth2\/v3\/authorize\?locale=/);
        for (const param of [
            'response_type=code',
            'state=state-123',
            'nonce=nonce-456',
            'client_id=client-id-123',
            `redirect_uri=${encodeURIComponent(baseParams.callbackUrl)}`,
        ]) {
            expect(url).toContain(param);
        }
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/app/login/route.test.ts
```

Expected: FAIL — `buildTeslaAuthorizeUrl` is not exported, and the URL currently
built by the route still contains `prompt=login`.

- [ ] **Step 3: Verify Tesla accepts the encoding before relying on it**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 20 \
  -X POST "https://auth.tesla.com/oauth2/v3/authorize?locale=en-US&response_type=code&scope=openid%20energy_device_data%20offline_access&state=s1&nonce=n1&client_id=INVALID&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&prompt_missing_scopes=true" \
  -H "Content-Type: application/json" -H "Origin: https://auth.tesla.com" -d '{}'
```

Expected: a Tesla JSON response (`200`), not a proxy-level rejection. If it
returns `403` from Akamai, retry once; intermittent 403s here are bot-scoring
noise, not a parameter rejection. Then repeat with `scope=openid+energy_device_data+offline_access`
and confirm it also returns `200`, which proves `+` would have worked too — we
keep `%20` regardless because it matches Tesla's documented example.

- [ ] **Step 4: Implement the authorize URL builder**

In `cmd/next-app/src/app/login/route.ts`, replace lines 42-49:

```ts
  const scopes = "openid%20energy_device_data%20offline_access%20user_data%20energy_cmds";
  const redirectBaseUrl = getAppBaseUrl(request);
  const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;
  const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;

  const uri = `https://auth.tesla.com/oauth2/v3/authorize?&locale=en-US&response_type=code&scope=${scopes}&state=${state}&redirect_uri=${callbackUrl}&client_id=${clientId}&nonce=${nonce}&prompt=login`;

  redirect(uri);
}
```

with:

```ts
  const redirectBaseUrl = getAppBaseUrl(request);
  const callbackUrl = `${redirectBaseUrl}/auth/tesla-callback`;
  const clientId = process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;

  redirect(
    buildTeslaAuthorizeUrl({
      state,
      nonce,
      callbackUrl,
      clientId: clientId ?? '',
    })
  );
}

const TESLA_AUTHORIZE_ENDPOINT = 'https://auth.tesla.com/oauth2/v3/authorize';

export interface TeslaAuthorizeUrlParams {
  state: string;
  nonce: string;
  callbackUrl: string;
  clientId: string;
}

export function buildTeslaAuthorizeUrl(params: TeslaAuthorizeUrlParams): string {
  const query = [
    ['locale', 'en-US'],
    ['response_type', 'code'],
    ['scope', 'openid energy_device_data offline_access user_data energy_cmds'],
    ['state', params.state],
    ['redirect_uri', params.callbackUrl],
    ['client_id', params.clientId],
    ['nonce', params.nonce],
    // Purpose-built replacement for prompt=login. Tesla documents this for
    // picking up newly-granted scopes; prompt=login additionally forces a full
    // re-authentication on every login.
    ['prompt_missing_scopes', 'true'],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  return `${TESLA_AUTHORIZE_ENDPOINT}?${query}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/app/login/route.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/login/route.ts src/app/login/route.test.ts
git commit -m "fix(auth): use prompt_missing_scopes and build a correctly encoded authorize URL"
```

---

**Implementation notes (learned while executing - do not re-derive):**

- **The plan's `%20` justification was partly wrong.** It claimed `encodeURIComponent`
  "matches Tesla's documented example". Checked: Tesla's docs give a name/required/example
  table and describe `scope` as a "Space delimited list" with **no** percent-encoded URL
  example, so the claim is unverifiable. Worse, RFC 6749 Appendix B specifies
  `application/x-www-form-urlencoded`, which encodes space as `+` - so the
  spec-conformant choice is the one this code rejects. The only load-bearing argument is
  that **production already emits `%20` and login works**, so keeping it preserves
  known-working behavior. Do not re-derive from the docs.
- **The plan's four builder tests never checked the wiring**, and every test still passed
  under four wiring mutations: swapping `state`/`nonce` at the call site, hardcoding
  `clientId`, and (found only by the quality review) passing `redirectBaseUrl` as the
  `callbackUrl`, which silently drops `/auth/tesla-callback` from the **only** parameter
  Tesla allowlists. A test that captures `state`/`nonce` from `cookieStore.set` and asserts
  the redirect equals `buildTeslaAuthorizeUrl({...})` closes all of them, and pins
  state-in-URL == state-in-cookie. Derive the expected `clientId` from
  `process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID`, **not** a literal, or the hardcode mutation
  still passes.
- That same assertion also closes the "a correct hand-inlined URL is indistinguishable"
  limit - there is no black-box test that separates *calls the builder* from *emits the
  same bytes*, but routing the assertion through the builder closes it in practice.
- **5 of the 10 new builder tests were provably redundant.** Deleting them and re-running
  all mutations left nothing silent. They re-asserted what one whole-string exact-equality
  assertion already pinned. The round-trip test was the worst: it *passes* even when
  encoding is swapped for `+`, because `+` decodes back to a space, and its assertion was
  already pinned by the scoped `%20` test. Deleting redundant tests is not a loss - prove
  it by deleting and re-running the mutations before claiming either way.
- **The `requireEnv` position after the cookie writes is deliberately unpinned.** A throw
  in a Next.js route handler discards the pending cookie-mutation buffer, so a 500 yields
  **zero `Set-Cookie` headers** - verified against `next start`, not assumed. A mocked
  `next/headers` cannot model this, so no unit test can pin it. It rests on undocumented
  framework behavior, which is why the position carries a comment rather than an assertion.
- `requireEnv` now has three callers, and `/login` is the first one outside a token path.
  A token-endpoint module exporting a generic env accessor is the wrong home - relocation
  to `lib/env.ts` is logged in `TODO.md`, along with moving `buildTeslaAuthorizeUrl` to
  `lib/tesla-authorize-url.ts` and making `/login` return `login_unavailable` like the
  callback route does.
- `prompt_missing_scopes=true` **cannot** silently grant scopes - verified against Tesla's
  docs; it prompts for un-granted scopes and silently reuses existing grants. The sibling
  `require_requested_scopes` is not set, so a user who *declines* a newly-added scope would
  still complete login with a partial grant. Latent today (static scope set); logged.

---

## Task 9: Document the corrected behavior

**Files:**
- Modify: `Authentication.md`
- Modify: `Agents.md` only if the env var list changed (it did not)

- [ ] **Step 1: Update the OAuth walkthrough**

In `Authentication.md`, find the section describing the Tesla OAuth walkthrough
(around lines 47-129). Make these edits:

Replace the note about `prompt=login` (currently around lines 64-67) with:

```markdown
Scope additions are picked up by sending the user through `/authorize` with
`prompt_missing_scopes=true`. This replaced a long-standing `prompt=login`
parameter, which forced a full Tesla re-authentication on every login. Existing
refresh tokens are still not retroactively upgraded with newly-granted scopes —
the user must complete a fresh authorize redirect.
```

Add a new subsection documenting JWKS handling, placed after the token exchange
description:

```markdown
### ID token signature verification

Tesla publishes two OIDC issuers, and each serves a **different** signing key
set:

| Issuer | JWKS |
| --- | --- |
| `https://auth.tesla.com/oauth2/v3/nts` | `/oauth2/v3/discovery/thirdparty/keys` |
| `https://auth.tesla.com/oauth2/v3` | `/oauth2/v3/discovery/keys` |

Tesla issues `/nts` tokens. We resolve the JWKS URI from each issuer's own
discovery document and cache it for an hour; if discovery is unavailable we fall
back to the URI matching the token's issuer, never a single hardcoded one.

Key lookup is delegated entirely to `jwks-rsa`, which memoizes per `kid` and
already refetches the full key set on an unknown `kid`, rate-limited. **Do not
add a manual JWKS refetch** — it would bypass the rate limiter and can only ever
look at the cached URI.

There is a degraded path (`tesla-auth-service.ts`) that completes login when
Tesla signs an ID token with a `kid` that is genuinely absent from the published
key set. It bypasses signature verification and is only reached when
`jwks-rsa` reports `SigningKeyNotFoundError` — meaning the authoritative key set
was successfully fetched and did not contain the key. An unreachable or
rate-limited endpoint must never map to that error; those fail closed as
`invalid-id-token`.
```

Add a note about token endpoints:

```markdown
### Token endpoint hosts

Tesla's documentation requires `/token` calls from application servers to use
`https://fleet-auth.prd.vn.cloud.tesla.com`, which carries different rate limits
than the browser-facing host. The OIDC discovery document still declares
`auth.tesla.com`, so `src/lib/tesla-token-endpoint.ts` tries `fleet-auth` first
and falls back to `auth.tesla.com` on transport failure or 5xx only. A 4xx is a
genuine authentication failure and is never retried against another host.
```

- [ ] **Step 2: Add the passkey troubleshooting note**

Append to `Authentication.md`:

```markdown
### Troubleshooting: "passkey failed" on auth.tesla.com

Tesla supports passkeys as an account sign-in credential. A passkey that a
password manager offers for `auth.tesla.com` will be **rejected by Tesla** if it
was never enrolled through Tesla's own account security page — Tesla holds no
public key to verify it against. The symptom is a "passkey failed" error on
Tesla's page, with the password manager insisting the passkey is valid.

Resolution: enroll the passkey at
`https://accounts.tesla.com/account-settings/security`, then sign in normally.
Nothing in this app needs to change; the failure occurs entirely on Tesla's
origin before our callback runs.
```

- [ ] **Step 3: Verify the docs render sensibly**

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add Authentication.md
git commit -m "docs: record Tesla JWKS issuer mapping, token host policy and passkey troubleshooting"
```

---

## Verification gotcha: never chain `npm run build` before `npx tsc --noEmit`

`tsconfig.json` sets `"incremental": true` and `npm run build` rewrites
`tsconfig.tsbuildinfo`. Running the two back to back in one shell command makes the
first `tsc` pass report against stale build state — observed once as **3** errors instead
of the expected 18, which reads as either a huge regression or a suddenly clean tree,
depending on which number you were expecting. Three consecutive isolated runs then gave
18/18/18.

**Run `npx tsc --noEmit` on its own, not chained after a build.** This matters most at
Task 10, where the expected number is a hard gate.

---

## Task 10: Final verification

**Files:** none modified

- [ ] **Step 1: Run the full test suite**

```bash
npx vitest run
```

Expected: PASS, no failures. Use `npx vitest run`, **not** `npm test` — the
package.json `test` script is bare `vitest`, which runs in watch mode and will
hang a non-interactive agent. Baseline for comparison on this branch after
Task 2: **869 passed, 1 skipped, across 104 files** (was 854 before Task 1's test file
grew from 8 to 17 cases).

Note: `npx tsc --noEmit` reports 18 pre-existing errors in this repo, all in
unrelated test files (`bill-summary/route.test.ts`, `session/route.test.ts`,
`trmnl/webhook/route.test.ts`, `db.test.ts`, `trmnl/render-full.test.ts`,
`trmnl/sections/load-timing.test.ts`, `proxy.test.ts`). None are in the files
this plan touches. Do not attempt to fix them.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Confirm no `any` types were introduced**

Diff against the design-doc commit `96007a1`, which is the base for this plan:

```bash
git diff 96007a1..HEAD -- '*.ts' '*.tsx' | grep -nE '^\+.*: any' || echo "no 'any' introduced"
```

Expected: `no 'any' introduced`.

- [ ] **Step 5: Confirm no manual JWKS refetch survived**

```bash
grep -n "fetchFreshJwks\|logAvailableKeys\|teslaJwksUri" src/lib/tesla-auth-service.ts || echo "manual JWKS refetch fully removed"
```

Expected: `manual JWKS refetch fully removed`. A reference to `teslaJwksUri` as a
local variable inside `getTeslaJwksUri` is fine; the module-level cache variable
must be gone.

- [ ] **Step 6: Confirm no placeholder credential remains**

```bash
grep -rn "ownerapi" src/lib/ || echo "no ownerapi default remains"
```

Expected: `no ownerapi default remains`.

- [ ] **Step 7: Update TODO.md if this closes tracked work**

Search `TODO.md` for any entry about Tesla OAuth, JWKS, or passkeys. If present,
remove or amend it. Otherwise skip.

- [ ] **Step 8: Report staging and deployment notes**

In the final report, state explicitly:

- Item 2 of the design trades availability for security: a Tesla JWKS outage now
  produces login failures instead of a silent verification downgrade. The stale
  key window is one hour; confirm that is acceptable.
- `prompt_missing_scopes=true` is the only user-visible change. It should be
  verified on staging with an account that has not granted all scopes.
- The `cacheMaxAgeFallback` one-hour window is an explicit security/availability
  trade and should be reviewed by a human before production.
