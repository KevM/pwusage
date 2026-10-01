/**
 * Read a required environment variable, failing loudly by name.
 *
 * Guards against silently substituting a placeholder credential — the previous
 * refresh implementation defaulted client_id to the literal 'ownerapi', which
 * would have presented our client_secret to the first-party Owner API.
 *
 * Deliberately NOT memoized. A cache here would have to be resettable to keep
 * `tesla-auth-service.test.ts`'s "never sends a request when the client secret
 * is missing" honest, and a credential reader that cannot observe a removed
 * value is the wrong shape for a function whose entire job is to fail loudly
 * when one is gone. The lookup is a ~200ns object property access on paths that
 * then make an 8-second request to Tesla, so there is nothing to win. The caches
 * in this codebase are for the expensive things: the JWKS client
 * (`tesla-auth-service.ts`) and the completed-days rollup (`cycle-rollup-cache.ts`).
 */
export function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
