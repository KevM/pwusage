import { describe, expect, it } from 'vitest';
import type { SiteSolarLayoutRow } from '@/lib/solar-layout-repo';
import { toMobileSolarLayout } from './mobile-contract';

function row(overrides: Partial<SiteSolarLayoutRow> = {}): SiteSolarLayoutRow {
    return {
        siteId: 's1', latitude: 43.39, longitude: -87.87, locationSetAt: new Date('2026-10-01T00:00:00Z'),
        result: null, status: 'pending', detectedAt: null, attemptedAt: null, detectorVersion: null,
        locationSource: 'device',
        ...overrides,
    };
}

const detectedResult = {
    status: 'detected', confidence: 'high', reasons: [], acClipKw: null,
    planes: [{ azimuth: 108.9, tilt: 19.3, dcKwp: 5.03, effectiveKw: 4.28, azimuthRange90: [107, 111], tiltRange90: [18, 21] }],
} as never;

describe('toMobileSolarLayout location source', () => {
    it('reports a phone location as device', () => {
        expect(toMobileSolarLayout(row({ locationSource: 'device' }))).toMatchObject({
            location: { latitude: 43.39, longitude: -87.87, source: 'device' },
        });
    });

    it('reports an admin-seeded location as estimated', () => {
        expect(toMobileSolarLayout(row({ locationSource: 'estimated' }))).toMatchObject({
            location: { latitude: 43.39, longitude: -87.87, source: 'estimated' },
        });
    });

    it('serialises a null source as estimated, since every earlier location was admin-seeded', () => {
        expect(toMobileSolarLayout(row({ locationSource: null }))).toMatchObject({
            location: { latitude: 43.39, longitude: -87.87, source: 'estimated' },
        });
    });

    it('keeps the source alongside a served layout', () => {
        const body = toMobileSolarLayout(row({ status: 'detected', result: detectedResult, locationSource: 'device', detectedAt: new Date('2026-10-27T12:00:00Z') }));
        expect(body).toMatchObject({ enabled: true, reason: null, location: { source: 'device' }, layout: { confidence: 'high' } });
    });

    it('has no location, and so no source, before a location is stored', () => {
        expect(toMobileSolarLayout(null)).toEqual({ version: 1, enabled: true, location: null, layout: null, reason: 'needs-location' });
        expect(toMobileSolarLayout(row({ latitude: null, longitude: null, locationSource: null }))).toMatchObject({ location: null, reason: 'needs-location' });
    });
});
