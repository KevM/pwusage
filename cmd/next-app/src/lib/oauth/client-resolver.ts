import dns from 'node:dns';
import net from 'node:net';
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
    fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
        [0xc0a80000, 0xffff0000], // 192.168.0.0/16
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

    const fetchFn = deps?.fetchFn ?? fetch;
    let response: Response;
    try {
        response = await fetchFn(clientId, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
        });
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
