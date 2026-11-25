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
