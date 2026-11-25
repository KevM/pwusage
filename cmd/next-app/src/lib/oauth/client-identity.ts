import type { OAuthClientMetadata } from './types';

/** Where the browser goes after Allow: the one place the authorization code is delivered. */
export type ClientReturnTo =
    | { kind: 'web'; host: string }
    | { kind: 'device' }
    | { kind: 'app'; scheme: string };

/**
 * What the consent screen may claim about an app. A self-registered (DCR) app
 * chooses its own name and homepage, so only the redirect is trustworthy: the
 * code goes there. A metadata-document (CIMD) app is vouched for by the host
 * that serves its client_id URL.
 */
export interface ClientIdentity {
    /** Self-asserted display name; never proof of who the app is. */
    name: string;
    /** True only when a host we fetched from vouches for the app (CIMD). */
    verified: boolean;
    /** Host serving the CIMD client_id document; null for self-registered apps. */
    publisherHost: string | null;
    returnTo: ClientReturnTo;
    /** client_uri host, shown only when it is on the same site as the publisher or redirect. */
    homepageHost: string | null;
}

function isSameOrRelatedHost(a: string, b: string): boolean {
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function hostOf(url: string | null): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname || null;
    } catch {
        return null;
    }
}

function describeReturnTo(redirectUri: string): ClientReturnTo {
    const url = new URL(redirectUri);
    if (url.protocol === 'https:') return { kind: 'web', host: url.hostname };
    if (url.protocol === 'http:') return { kind: 'device' }; // validateRedirectUri allows http only for loopback
    return { kind: 'app', scheme: url.protocol.slice(0, -1) };
}

export function describeClientIdentity(client: OAuthClientMetadata, redirectUri: string): ClientIdentity {
    const returnTo = describeReturnTo(redirectUri);
    const publisherHost = client.kind === 'cimd' ? hostOf(client.clientId) : null;
    // The homepage must be anchored to something the app cannot fake: the CIMD
    // host, else a web redirect host. Device and app-scheme redirects anchor nothing.
    const anchor = publisherHost ?? (returnTo.kind === 'web' ? returnTo.host : null);
    const clientUriHost = hostOf(client.clientUri);
    const homepageHost = anchor && clientUriHost && isSameOrRelatedHost(clientUriHost, anchor) ? clientUriHost : null;

    return {
        name: client.clientName,
        verified: publisherHost !== null,
        publisherHost,
        returnTo,
        homepageHost,
    };
}
