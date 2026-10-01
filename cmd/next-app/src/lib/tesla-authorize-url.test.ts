import { describe, expect, it } from 'vitest';
import { buildTeslaAuthorizeUrl } from './tesla-authorize-url';

/** Reads a query parameter's raw (still percent-encoded) value out of a URL. */
function rawQueryValue(url: string, key: string): string | undefined {
    return new URL(url).search.match(new RegExp(`[?&]${key}=([^&]*)`))?.[1];
}

describe('buildTeslaAuthorizeUrl', () => {
    const baseParams = {
        state: 'state-123',
        nonce: 'nonce-456',
        callbackUrl: 'https://pwusage.fm.rodeo/auth/tesla-callback',
        clientId: 'client-id-123',
    };

    // Asserted by exact equality rather than a pile of toContain calls: equality
    // also catches a dropped parameter, an extra parameter, and any encoding
    // drift, none of which independent substring checks would notice. Parameter
    // order is not load-bearing -- OAuth consumers treat the query as a set.
    it('encodes the complete authorize URL exactly, in a stable order', () => {
        expect(buildTeslaAuthorizeUrl(baseParams)).toBe(
            'https://auth.tesla.com/oauth2/v3/authorize?locale=en-US&response_type=code'
            + '&scope=openid%20energy_device_data%20offline_access%20user_data%20energy_cmds'
            + '&state=state-123'
            + '&redirect_uri=https%3A%2F%2Fpwusage.fm.rodeo%2Fauth%2Ftesla-callback'
            + '&client_id=client-id-123'
            + '&nonce=nonce-456'
            + '&prompt_missing_scopes=true'
        );
    });

    // `state-123` and `nonce-456` need no escaping, so they cannot catch a
    // regression in the encoding itself. These values exercise every character
    // class the old string interpolation dropped on the floor.
    describe('encoding reserved characters', () => {
        const reservedParams = {
            state: 'st+ate/va=lue here',
            nonce: 'no+nce/va=lue here',
            callbackUrl: baseParams.callbackUrl,
            clientId: baseParams.clientId,
        };

        it('escapes +, / and = instead of passing them through raw', () => {
            expect(rawQueryValue(buildTeslaAuthorizeUrl(reservedParams), 'state'))
                .toBe('st%2Bate%2Fva%3Dlue%20here');
        });

        // Scoped to the nonce value rather than the whole URL: a blanket
        // not.toContain('+') would also fail for an unrelated reason if an input
        // ever legitimately carried a literal '+'.
        it('encodes the space as %20, which URLSearchParams.toString() would emit as +', () => {
            const rawNonce = rawQueryValue(buildTeslaAuthorizeUrl(reservedParams), 'nonce');

            expect(rawNonce).toBe('no%2Bnce%2Fva%3Dlue%20here');
            expect(rawNonce).toContain('%20');
            expect(rawNonce).not.toContain('+');
        });
    });
});
