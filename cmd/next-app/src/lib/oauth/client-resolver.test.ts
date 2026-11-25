import { describe, expect, it, vi } from 'vitest';
import { isBlockedIpAddress, isCimdClientId, pinnedLookup, resolveOAuthClient } from './client-resolver';

describe('client-resolver', () => {
    it('identifies valid HTTPS CIMD client_ids with non-empty path and rejects others', () => {
        expect(isCimdClientId('https://client.example.com/oauth/client.json')).toBe(true);
        expect(isCimdClientId('https://client.example.com/')).toBe(false);
        expect(isCimdClientId('http://client.example.com/client.json')).toBe(false);
        expect(isCimdClientId('https://127.0.0.1/client.json')).toBe(false);
        expect(isCimdClientId('pwu_client_123')).toBe(false);
    });

    it('accepts only default-port, hostname CIMD client_ids that are not PWUsage itself', () => {
        vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://pwusage.fm.rodeo');
        try {
            expect(isCimdClientId('https://target.example:6379/x.json')).toBe(false);
            expect(isCimdClientId('https://agent.example.com:443/x.json')).toBe(true);
            expect(isCimdClientId('https://[::1]/client.json')).toBe(false);
            expect(isCimdClientId('https://pwusage.fm.rodeo/client.json')).toBe(false);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('blocks IPv6 Teredo, IETF/benchmarking and discard ranges, in any spelling', () => {
        for (const ip of ['2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:2::1', '2001:1ff::1', '100::1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:127.0.0.1', '::FFFF:10.0.0.1']) {
            expect(isBlockedIpAddress(ip), ip).toBe(true);
        }
        expect(isBlockedIpAddress('2001:200::1')).toBe(false); // global unicast just past 2001::/23
        expect(isBlockedIpAddress('2001:4860:4860::8888')).toBe(false);
    });

    it('returns null instead of throwing when the CIMD body errors mid-stream, and cancels rejected bodies', async () => {
        const url = 'https://agent.example.com/stall.json';
        const stalled = new ReadableStream<Uint8Array>({
            pull() { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
        });
        await expect(resolveOAuthClient(url, {
            lookupIps: vi.fn().mockResolvedValue(['93.184.216.34']),
            fetchFn: vi.fn().mockResolvedValue(new Response(stalled, { status: 200 })),
            getDcrClient: vi.fn(),
        })).resolves.toBeNull();

        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        await resolveOAuthClient('https://agent.example.com/missing.json', {
            lookupIps: vi.fn().mockResolvedValue(['93.184.216.34']),
            fetchFn: vi.fn().mockResolvedValue(new Response(body, { status: 404 })),
            getDcrClient: vi.fn(),
        });
        expect(cancel).toHaveBeenCalled();
    });

    it('blocks private, loopback, link-local, and metadata IPs', () => {
        expect(isBlockedIpAddress('127.0.0.1')).toBe(true);
        expect(isBlockedIpAddress('10.0.0.5')).toBe(true);
        expect(isBlockedIpAddress('169.254.169.254')).toBe(true);
        expect(isBlockedIpAddress('172.16.0.1')).toBe(true);
        expect(isBlockedIpAddress('192.168.1.1')).toBe(true);
        expect(isBlockedIpAddress('::1')).toBe(true);
        expect(isBlockedIpAddress('fe80::1')).toBe(true);
        expect(isBlockedIpAddress('93.184.216.34')).toBe(false);
    });

    it('blocks reserved, documentation and IPv6 transition ranges that can reach internal IPv4', () => {
        for (const ip of [
            '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
            '64:ff9b::a00:1', // NAT64 of 10.0.0.1
            '2002:a00:1::1', // 6to4 of 10.0.0.1
            '::a00:1', // IPv4-compatible 10.0.0.1
            '2001:db8::1',
        ]) {
            expect(isBlockedIpAddress(ip), ip).toBe(true);
        }
        expect(isBlockedIpAddress('2606:4700::6810:84e5')).toBe(false);
    });

    it('pinnedLookup answers only with the validated addresses, whatever DNS says now', async () => {
        const lookup = pinnedLookup(['93.184.216.34', '2606:4700::6810:84e5']);
        const one = await new Promise<[string, number]>((resolve, reject) =>
            lookup('agent.example.com', {}, (err, address, family) => (err ? reject(err) : resolve([address as string, family as number]))));
        expect(one).toEqual(['93.184.216.34', 4]);
        const all = await new Promise<unknown>((resolve, reject) =>
            lookup('agent.example.com', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))));
        expect(all).toEqual([
            { address: '93.184.216.34', family: 4 },
            { address: '2606:4700::6810:84e5', family: 6 },
        ]);
    });

    it('connects the CIMD fetch only to the addresses that passed the block check', async () => {
        const url = 'https://agent.example.com/pinned.json';
        const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            client_id: url, client_name: 'Pinned', redirect_uris: ['https://agent.example.com/cb'],
        }), { status: 200 }));
        await resolveOAuthClient(url, {
            lookupIps: vi.fn().mockResolvedValue(['93.184.216.34']),
            fetchFn,
            getDcrClient: vi.fn().mockResolvedValue(null),
        });
        expect(fetchFn).toHaveBeenCalledWith(url, ['93.184.216.34']);
    });

    it('fetches and validates a public CIMD document and rejects mismatched client_id', async () => {
        const url = 'https://agent.example.com/mcp-client.json';
        const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            client_id: url,
            client_name: 'Example Agent',
            redirect_uris: ['https://agent.example.com/cb'],
            token_endpoint_auth_method: 'none',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const resolved = await resolveOAuthClient(url, {
            lookupIps: vi.fn().mockResolvedValue(['93.184.216.34']),
            fetchFn,
            getDcrClient: vi.fn().mockResolvedValue(null),
        });
        expect(resolved).toEqual({
            clientId: url,
            clientName: 'Example Agent',
            redirectUris: ['https://agent.example.com/cb'],
            clientUri: null,
            kind: 'cimd',
        });

        const mismatchUrl = 'https://agent.example.com/mismatch.json';
        const mismatchFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            client_id: 'https://other.example.com/client.json',
            client_name: 'Mismatch Agent',
            redirect_uris: ['https://agent.example.com/cb'],
            token_endpoint_auth_method: 'none',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const mismatched = await resolveOAuthClient(mismatchUrl, {
            lookupIps: vi.fn().mockResolvedValue(['93.184.216.34']),
            fetchFn: mismatchFetch,
            getDcrClient: vi.fn().mockResolvedValue(null),
        });
        expect(mismatched).toBeNull();
    });

    it('rejects CIMD host resolving to private IP without calling fetch', async () => {
        const fetchFn = vi.fn();
        const resolved = await resolveOAuthClient('https://internal.example.com/client.json', {
            lookupIps: vi.fn().mockResolvedValue(['10.0.0.1']),
            fetchFn,
            getDcrClient: vi.fn().mockResolvedValue(null),
        });
        expect(resolved).toBeNull();
        expect(fetchFn).not.toHaveBeenCalled();
    });
});
