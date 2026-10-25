import { describe, expect, it } from 'vitest';
import {
    DEFAULT_FLEET_BASE_URL,
    EU_FLEET_BASE_URL,
    fleetBaseUrlFrom421,
    normalizeFleetBaseUrl,
    parseTesla421,
} from './tesla-region';

describe('normalizeFleetBaseUrl', () => {
    it('accepts the documented regional Fleet hosts', () => {
        expect(normalizeFleetBaseUrl('https://fleet-api.prd.na.vn.cloud.tesla.com')).toBe(DEFAULT_FLEET_BASE_URL);
        expect(normalizeFleetBaseUrl('https://fleet-api.prd.eu.vn.cloud.tesla.com')).toBe(EU_FLEET_BASE_URL);
        expect(normalizeFleetBaseUrl('https://fleet-api.prd.cn.vn.cloud.tesla.cn')).toBe('https://fleet-api.prd.cn.vn.cloud.tesla.cn');
    });

    it('normalizes a trailing slash and host case', () => {
        expect(normalizeFleetBaseUrl('https://FLEET-API.prd.eu.vn.cloud.tesla.com/')).toBe(EU_FLEET_BASE_URL);
    });

    it('rejects anything that is not exactly an allowlisted https origin', () => {
        for (const url of [
            'http://fleet-api.prd.eu.vn.cloud.tesla.com',
            'https://fleet-api.prd.eu.vn.cloud.tesla.com.evil.com',
            'https://evil.com/?h=fleet-api.prd.eu.vn.cloud.tesla.com',
            'https://user:pw@fleet-api.prd.eu.vn.cloud.tesla.com',
            'https://fleet-api.prd.eu.vn.cloud.tesla.com:8443',
            'https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1',
            'not a url',
            '',
            null,
            undefined,
            42,
        ]) {
            expect(normalizeFleetBaseUrl(url)).toBeNull();
        }
    });
});

describe('fleetBaseUrlFrom421', () => {
    it('extracts the allowlisted base URL from Tesla\'s out-of-region body', () => {
        const body = '{"response":null,"error":"user out of region, use base URL: https://fleet-api.prd.eu.vn.cloud.tesla.com, see https://developer.tesla.com/docs/fleet-api#endpoints-and-regions","error_description":""}';
        expect(fleetBaseUrlFrom421(body)).toBe(EU_FLEET_BASE_URL);
    });

    it('ignores hosts outside the allowlist', () => {
        expect(fleetBaseUrlFrom421('{"error":"user out of region, use base URL: https://evil.example.com"}')).toBeNull();
        expect(fleetBaseUrlFrom421('misdirected')).toBeNull();
    });
});

describe('parseTesla421', () => {
    it('classifies an out-of-region answer and returns the named host', () => {
        const body = `{"response":null,"error":"user out of region, use base URL: ${EU_FLEET_BASE_URL}, see https://developer.tesla.com/docs/fleet-api#endpoints-and-regions"}`;
        expect(parseTesla421(body)).toEqual({
            kind: 'out-of-region',
            baseUrl: EU_FLEET_BASE_URL,
        });
    });

    it('classifies an unregistered partner even when the named host is the current host', () => {
        const body = `{"response":null,"error":"Account abc must be registered in the current region ${EU_FLEET_BASE_URL}, please see https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries"}`;
        expect(parseTesla421(body)).toEqual({
            kind: 'partner-not-registered',
            baseUrl: EU_FLEET_BASE_URL,
        });
    });

    it('does not classify unrelated 421 bodies as a region change', () => {
        expect(parseTesla421('{"error":"teapot"}')).toEqual({ kind: 'unknown', baseUrl: null });
        expect(parseTesla421('')).toEqual({ kind: 'unknown', baseUrl: null });
    });

    it('ignores unallowlisted hosts in a registration message', () => {
        expect(parseTesla421('{"error":"Account abc must be registered in the current region https://evil.example.com"}')).toEqual({
            kind: 'partner-not-registered',
            baseUrl: null,
        });
    });
});
