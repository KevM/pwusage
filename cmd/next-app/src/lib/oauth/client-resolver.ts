import dns from 'node:dns';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { OAuthClientMetadata } from './types';
import { validateRedirectUri } from './validation';

const CIMD_CACHE_TTL_MS = 5 * 60 * 1000;
const CIMD_CACHE_MAX_ENTRIES = 200;
const CIMD_FETCH_TIMEOUT_MS = 3000;
const CIMD_MAX_BODY_BYTES = 16_384;

interface CachedCimdEntry {
    metadata: OAuthClientMetadata;
    expiresAt: number;
}

const cimdCache = new Map<string, CachedCimdEntry>();

export interface ClientResolverDeps {
    lookupIps?: (hostname: string) => Promise<string[]>;
    /** GET the CIMD document, connecting only to `pinnedIps` (already checked against the blocklist). */
    fetchFn?: (url: string, pinnedIps: string[]) => Promise<Response>;
    getDcrClient?: (clientId: string) => Promise<OAuthClientMetadata | null>;
}

export function isCimdClientId(clientId: string): boolean {
    if (!clientId || clientId.length > 2048) return false;
    let parsed: URL;
    try {
        parsed = new URL(clientId);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (!parsed.hostname || net.isIP(parsed.hostname) !== 0) return false;
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (!parsed.pathname || parsed.pathname === '/') return false;
    return true;
}

function parseIpv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet < 0 || octet > 255) return null;
        value = (value << 8) | octet;
    }
    return value >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
    const addr = parseIpv4ToInt(ip);
    if (addr === null) return true;
    const ranges: Array<[number, number]> = [
        [0x00000000, 0xff000000], // 0.0.0.0/8
        [0x0a000000, 0xff000000], // 10.0.0.0/8
        [0x64400000, 0xffc00000], // 100.64.0.0/10 (CGNAT)
        [0x7f000000, 0xff000000], // 127.0.0.0/8 (loopback)
        [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 (link-local / metadata)
        [0xac100000, 0xfff00000], // 172.16.0.0/12
        [0xc0000000, 0xffffff00], // 192.0.0.0/24 (IETF protocol assignments)
        [0xc0000200, 0xffffff00], // 192.0.2.0/24 (TEST-NET-1)
        [0xc0a80000, 0xffff0000], // 192.168.0.0/16
        [0xc6120000, 0xfffe0000], // 198.18.0.0/15 (benchmarking)
        [0xc6336400, 0xffffff00], // 198.51.100.0/24 (TEST-NET-2)
        [0xcb007100, 0xffffff00], // 203.0.113.0/24 (TEST-NET-3)
        [0xe0000000, 0xf0000000], // 224.0.0.0/4 (multicast)
        [0xf0000000, 0xf0000000], // 240.0.0.0/4 (reserved)
    ];
    return ranges.some(([base, mask]) => ((addr & mask) >>> 0) === (base >>> 0));
}

function isBlockedIpv6(ip: string): boolean {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length);
        if (net.isIPv4(mapped)) return isBlockedIpv4(mapped);
        return true;
    }
    // ::/96 (IPv4-compatible), NAT64 64:ff9b::/96, 6to4 2002::/16 and documentation
    // 2001:db8::/32 can all carry or reach an internal IPv4 address.
    if (normalized.startsWith('::')) return true;
    if (normalized.startsWith('64:ff9b:') || normalized.startsWith('2002:') || normalized.startsWith('2001:db8:')) return true;
    const firstHextet = normalized.split(':')[0];
    if (firstHextet) {
        const value = Number.parseInt(firstHextet, 16);
        if (!Number.isNaN(value)) {
            if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
            if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
            if ((value & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
        }
    }
    return false;
}

export function isBlockedIpAddress(ip: string): boolean {
    const kind = net.isIP(ip);
    if (kind === 4) return isBlockedIpv4(ip);
    if (kind === 6) return isBlockedIpv6(ip);
    return true;
}

async function defaultLookupIps(hostname: string): Promise<string[]> {
    const records = await dns.promises.lookup(hostname, { all: true });
    return records.map(record => record.address);
}

/**
 * A DNS lookup that answers only with addresses already checked against the
 * blocklist. Handing it to the connection closes the DNS-rebinding gap where
 * the check sees a public address and the connect-time lookup a private one.
 */
export function pinnedLookup(ips: string[]): LookupFunction {
    const entries = ips.map(address => ({ address, family: net.isIP(address) }));
    return (_hostname, options, callback) => {
        if (options.all) {
            callback(null, entries);
            return;
        }
        const wanted = options.family === 4 || options.family === 6 ? entries.find(e => e.family === options.family) : entries[0];
        if (!wanted) {
            callback(Object.assign(new Error('No validated address for the requested family'), { code: 'ENOTFOUND' }), '', 0);
            return;
        }
        callback(null, wanted.address, wanted.family);
    };
}

/**
 * GET over HTTPS, connected to `pinnedIps` only. TLS still verifies the URL's
 * hostname (SNI and certificate), and redirects are not followed.
 */
function fetchPinned(url: string, pinnedIps: string[]): Promise<Response> {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            lookup: pinnedLookup(pinnedIps),
            // A fresh connection: a pooled keep-alive socket would skip the pinned lookup.
            agent: false,
            signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
        }, res => {
            const status = res.statusCode ?? 502;
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
                if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
                else if (value !== undefined) headers.set(key, value);
            }
            const hasBody = status >= 200 && ![204, 205, 304].includes(status);
            if (!hasBody) res.resume();
            resolve(new Response(hasBody ? (Readable.toWeb(res) as ReadableStream<Uint8Array>) : null, { status, headers }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
        return null;
    }
    if (!response.body) {
        const text = await response.text();
        return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function getCachedCimd(clientId: string): OAuthClientMetadata | null {
    const entry = cimdCache.get(clientId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        cimdCache.delete(clientId);
        return null;
    }
    return entry.metadata;
}

function setCachedCimd(clientId: string, metadata: OAuthClientMetadata): void {
    if (cimdCache.size >= CIMD_CACHE_MAX_ENTRIES) {
        const firstKey = cimdCache.keys().next().value;
        if (firstKey !== undefined) cimdCache.delete(firstKey);
    }
    cimdCache.set(clientId, {
        metadata,
        expiresAt: Date.now() + CIMD_CACHE_TTL_MS,
    });
}

function validateCimdDocument(clientId: string, raw: unknown): OAuthClientMetadata | null {
    if (!raw || typeof raw !== 'object') return null;
    const doc = raw as Record<string, unknown>;
    if (doc.client_id !== clientId) return null;
    if (
        doc.token_endpoint_auth_method !== undefined
        && doc.token_endpoint_auth_method !== 'none'
    ) {
        return null;
    }
    if (typeof doc.client_name !== 'string') return null;
    const clientName = doc.client_name.trim();
    if (clientName.length < 1 || clientName.length > 120) return null;

    if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || doc.redirect_uris.length > 20) {
        return null;
    }
    const redirectUris: string[] = [];
    for (const uri of doc.redirect_uris) {
        if (typeof uri !== 'string') return null;
        const checked = validateRedirectUri(uri);
        if (!checked.ok) return null;
        redirectUris.push(checked.normalized);
    }

    let clientUri: string | null = null;
    if (typeof doc.client_uri === 'string' && doc.client_uri.trim()) {
        try {
            const parsedUri = new URL(doc.client_uri.trim());
            if (parsedUri.protocol === 'https:' || parsedUri.protocol === 'http:') {
                clientUri = parsedUri.href;
            }
        } catch {
            return null;
        }
    }

    return {
        clientId,
        clientName,
        redirectUris,
        clientUri,
        kind: 'cimd',
    };
}

export async function resolveOAuthClient(
    clientId: string,
    deps?: ClientResolverDeps,
): Promise<OAuthClientMetadata | null> {
    if (!isCimdClientId(clientId)) {
        if (deps?.getDcrClient) {
            return deps.getDcrClient(clientId);
        }
        const { getDcrClient } = await import('./oauth-repo');
        return getDcrClient(clientId);
    }

    const cached = getCachedCimd(clientId);
    if (cached) return cached;

    const parsed = new URL(clientId);
    const lookupIps = deps?.lookupIps ?? defaultLookupIps;
    let ips: string[];
    try {
        ips = await lookupIps(parsed.hostname);
    } catch {
        return null;
    }
    if (ips.length === 0 || ips.some(ip => isBlockedIpAddress(ip))) {
        return null;
    }

    const fetchFn = deps?.fetchFn ?? fetchPinned;
    let response: Response;
    try {
        response = await fetchFn(clientId, ips);
    } catch {
        return null;
    }
    if (!response.ok) return null;

    const text = await readBoundedText(response, CIMD_MAX_BODY_BYTES);
    if (!text) return null;

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(text);
    } catch {
        return null;
    }

    const metadata = validateCimdDocument(clientId, parsedJson);
    if (!metadata) return null;

    setCachedCimd(clientId, metadata);
    return metadata;
}
