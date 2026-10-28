import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAccessToken } from './tesla-auth';
import * as observability from './observability';
import { isTeslaAuthError, TeslaAuthError } from './tesla-client';

const ORIGINAL_ENV = {
    PUBLIC_TESLA_OAUTH_CLIENT_ID: process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID,
    TESLA_OAUTH_SECRET: process.env.TESLA_OAUTH_SECRET,
};

// Restore whatever the ambient environment had: process.env is shared with every
// other test file running in this worker, so leaving the fixtures behind would
// make an unrelated suite depend on this file's ordering.
function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
    const original = ORIGINAL_ENV[name];
    if (original === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = original;
    }
}

function okResponse(payload: Record<string, unknown>): Response {
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

describe('refreshAccessToken', () => {
    beforeEach(() => {
        process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID = 'client-id-123';
        process.env.TESLA_OAUTH_SECRET = 'secret-123';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    afterAll(() => {
        restoreEnvVar('PUBLIC_TESLA_OAUTH_CLIENT_ID');
        restoreEnvVar('TESLA_OAUTH_SECRET');
    });

    it('logs the access token lifetime and estimated expiry after refresh', async () => {
        const log = vi.spyOn(observability, 'logEvent');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })));
        const before = Date.now();
        await refreshAccessToken('old-refresh');
        expect(log).toHaveBeenCalledWith('info', 'tesla.refresh.credentials-parsed', expect.objectContaining({
            accessExpiresInSeconds: 3600,
            accessExpiresAt: expect.any(String),
        }));
        const fields = log.mock.calls.find(([, event]) => event === 'tesla.refresh.credentials-parsed')?.[2];
        expect(Date.parse(String(fields?.accessExpiresAt))).toBeGreaterThanOrEqual(before + 3600000);
        log.mockRestore();
    });

    it('posts a form-encoded refresh request without audience to the documented fleet-auth host', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            okResponse({ access_token: 'new-access', refresh_token: 'new-refresh' })
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await refreshAccessToken('old-refresh');

        // Reaching this assertion at all proves the response body was consumed
        // and returned; the body assertions below are what pin the request.
        expect(result).toEqual({ access_token: 'new-access', refresh_token: 'new-refresh' });

        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
        ]);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)['Content-Type']).toBe(
            'application/x-www-form-urlencoded'
        );

        // Exact equality over the parsed body, not four params.get() calls: a
        // dropped *or* an unexpected extra param must fail. Tesla's refresh
        // grant takes client_id and refresh_token; audience belongs only to the
        // authorization-code exchange.
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
            grant_type: 'refresh_token',
            client_id: 'client-id-123',
            client_secret: 'secret-123',
            refresh_token: 'old-refresh',
            scope: 'openid email offline_access',
        });
    });

    it('never sends the first-party ownerapi client id when the env var is unset', async () => {
        delete process.env.PUBLIC_TESLA_OAUTH_CLIENT_ID;
        // A *successful* mock on purpose: if the code under test still sends a
        // request, this resolves instead of rejecting and the not.toHaveBeenCalled
        // assertion names the secret that reached the wire. An always-throwing
        // mock would fail on an unrelated TypeError.
        const fetchMock = vi.fn().mockResolvedValue(
            okResponse({ access_token: 'new-access', refresh_token: 'new-refresh' })
        );
        vi.stubGlobal('fetch', fetchMock);

        // Presenting our client_secret to Tesla's first-party Owner API is the
        // security bug this guards: the previous `|| 'ownerapi'` default sent a
        // live request instead of failing.
        await expect(refreshAccessToken('old-refresh')).rejects.toThrow(
            /PUBLIC_TESLA_OAUTH_CLIENT_ID/
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never posts "undefined" as the client secret when the secret env var is unset', async () => {
        delete process.env.TESLA_OAUTH_SECRET;
        const fetchMock = vi.fn().mockResolvedValue(
            okResponse({ access_token: 'new-access', refresh_token: 'new-refresh' })
        );
        vi.stubGlobal('fetch', fetchMock);

        // Task 6 pins this guard for the code exchange in
        // tesla-auth-service.test.ts; nothing pinned it here. The old code read
        // `process.env.TESLA_OAUTH_SECRET` unguarded, so a misconfigured deploy
        // posted the literal string "undefined" as client_secret — and
        // not.toHaveBeenCalled() is the assertion that proves it does not.
        await expect(refreshAccessToken('old-refresh')).rejects.toThrow(/TESLA_OAUTH_SECRET/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Regression guard: this already worked and must keep working. A 400
    // login_required is what tells the caller the refresh token is dead and it
    // is safe to revoke (tesla-token-repo's isTerminalAuthError).
    it('raises TeslaAuthError on login_required so the caller can revoke', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => '{"error":"login_required"}',
        } as unknown as Response));

        await expect(refreshAccessToken('old-refresh')).rejects.toBeInstanceOf(TeslaAuthError);
    });

    // The 401 half of the decision table. Deleting `response.status === 401 ||`
    // from tesla-auth.ts used to leave the whole suite green — nothing pinned it.
    // Tesla documents 401 login_required as *the* refresh-failure response, and
    // this branch is the primary mass-revocation switch: TeslaTokenRepo turns it
    // into `auth_status = 'revoked', is_active = false` for every affected user.
    // Unconditional on body, because a 401 from this endpoint is not
    // distinguishable from a dead credential without reading the body.
    it('raises TeslaAuthError on a 401 regardless of the response body', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            // No trigger substring on purpose: this asserts the status-based
            // branch, not the body check.
            text: async () => 'Unauthorized',
        } as unknown as Response));

        await expect(refreshAccessToken('old-refresh')).rejects.toBeInstanceOf(TeslaAuthError);
    });

    // The mirror guard, and the inverse of the test above: a 400 whose body does
    // NOT carry a trigger substring must stay non-terminal. Reducing the 400
    // condition to bare `response.status === 400` also used to leave the suite
    // green. This is the misconfiguration case — Tesla documents 400
    // unauthorized_client for a wrong-but-present client_id or audience, and
    // revoking every user over a bad deploy would be the opposite of helpful.
    it('does not raise TeslaAuthError on a 400 with a non-trigger body', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => '{"error":"unauthorized_client"}',
        } as unknown as Response));

        const thrown = await refreshAccessToken('old-refresh').catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(TeslaAuthError);
        // A non-terminal error must not carry a trigger substring either, or
        // isTeslaAuthError revokes anyway — see DesignDecisions.md section 5.
        expect((thrown as Error).message).not.toMatch(/login_required|invalid_grant/);
    });

    // Upstream text is not evidence that the credential is dead. TeslaTokenRepo
    // turns isTeslaAuthError into an atomic revoke, so a 403 or 400 whose body
    // happens to contain a trigger substring must stay non-terminal. The message
    // must not carry that text either, because the predicate matches messages.
    it.each([
        { status: 403, body: '{"error":"login_required"}' },
        { status: 400, body: '{"error":"invalid authentication"}' },
    ])(
        'does not treat a $status response body containing a trigger as terminal',
        async ({ status, body }) => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status,
                text: async () => body,
            } as unknown as Response));

            const thrown = await refreshAccessToken('old-refresh').catch((err: unknown) => err);

            expect(thrown).toBeInstanceOf(Error);
            expect(thrown).not.toBeInstanceOf(TeslaAuthError);
            expect(isTeslaAuthError(thrown)).toBe(false);
            expect((thrown as Error).message).not.toMatch(/login_required|invalid_grant|invalid authentication/i);
        }
    );

    it('throws a plain, non-terminal error when a 200 response omits the tokens', async () => {
        // The body carries `invalid_grant` on purpose. With the benign fixture
        // this test used, an implementation that interpolated the payload into
        // the error message passed everything — which is precisely the bug the
        // DesignDecisions rule forbids. A body containing a trigger substring is
        // what makes the message a function of the implementation instead of a
        // fixed template.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            okResponse({ access_token: 'new-access', error: 'invalid_grant' })
        ));

        const thrown = await refreshAccessToken('old-refresh').catch((err: unknown) => err);

        // A malformed body is not proof the refresh token is revoked, and
        // isTeslaAuthError also matches some message substrings — so pin that
        // this stays outside TeslaAuthError and outside the revoke-triggering
        // substrings, which would take the user's account offline.
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(TeslaAuthError);
        expect((thrown as Error).message).toMatch(/access_token/);
        expect((thrown as Error).message).not.toMatch(/login_required|invalid_grant/);
    });

    it('rejects empty-string tokens rather than persisting them', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            okResponse({ access_token: '', refresh_token: '' })
        ));

        const thrown = await refreshAccessToken('old-refresh').catch((err: unknown) => err);

        // Empty strings satisfy a bare `typeof` check, so the previous guard
        // let them through and updateSiteTokens would have written '' as the
        // user's access and refresh tokens. A missing field must be equally
        // fatal to an empty one.
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(TeslaAuthError);
        expect((thrown as Error).message).toMatch(/access_token/);
    });

    it('falls back to auth.tesla.com when the primary host returns 5xx', async () => {
        // `text` is on the 5xx fixture even though the fixed code never reads it
        // (the helper retries on 5xx), so that any failure here is the URL/order
        // assertion rather than a TypeError from an incomplete mock.
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 502, text: async () => '' } as unknown as Response)
            .mockResolvedValueOnce(okResponse({ access_token: 'a', refresh_token: 'r' }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await refreshAccessToken('old-refresh');

        // Without consuming the fallback's body, the URL assertions below would
        // still hold even if the second response were discarded.
        expect(result).toEqual({ access_token: 'a', refresh_token: 'r' });

        // The ordered sequence, not just that both hosts were tried.
        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
            'https://auth.tesla.com/oauth2/v3/token',
        ]);
    });

    it('surfaces a non-terminal token-endpoint failure when every host 5xxs', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            text: async () => '',
        } as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);

        // Both hosts tried, then the helper's own error surfaces. This is a
        // caller-visible change from the old single-host "Failed to refresh
        // token: 503 ..." Error, so pin it.
        const thrown = await refreshAccessToken('old-refresh').catch((err: unknown) => err);

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/Tesla token endpoints failed/);

        // Non-terminal, and the previous name of this test said the opposite.
        // A 503 from both hosts is an outage, not evidence about the user's
        // credential: DesignDecisions.md §5 has TeslaTokenRepo release the
        // refresh lock rather than revoke. The old wording invited a reader to
        // "fix" this by classifying it as terminal, which would take the account
        // offline whenever Tesla had a bad minute.
        expect(thrown).not.toBeInstanceOf(TeslaAuthError);

        // isTeslaAuthError also matches message substrings, so the thrown
        // message must not carry a revoke trigger either. This catches a
        // regression that folds an upstream or intermediary body into a
        // classified message: a 503 whose cause read "... invalid_grant from
        // proxy" would otherwise flip this to terminal. parseRefreshedTokens
        // gets the same guard.
        expect((thrown as Error).message).not.toMatch(/login_required|invalid_grant|invalid authentication/i);

        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
            'https://auth.tesla.com/oauth2/v3/token',
        ]);
    });
});
