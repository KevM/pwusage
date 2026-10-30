import { describe, expect, it } from 'vitest';
import { describeLocationSource, describePlanes } from './SolarBetaManager';

describe('describeLocationSource', () => {
    it('labels a phone location and an admin estimate', () => {
        expect(describeLocationSource({ latitude: 43.39, locationSource: 'device' })).toBe('from phone');
        expect(describeLocationSource({ latitude: 43.39, locationSource: 'estimated' })).toBe('estimated');
    });

    it('treats a legacy location with no recorded source as estimated', () => {
        expect(describeLocationSource({ latitude: 43.39, locationSource: null })).toBe('estimated');
    });

    it('shows nothing without a location', () => {
        expect(describeLocationSource({ latitude: null, locationSource: null })).toBeNull();
    });
});

describe('describePlanes', () => {
    it('summarises each plane with compass point, tilt and size', () => {
        expect(describePlanes({
            planes: [{ azimuth: 106.1, tilt: 24.3, dcKwp: 4.91 }, { azimuth: 283.3, tilt: 22, dcKwp: 6.62 }],
            acClipKw: null,
        })).toBe('E 106° · 24° · 4.9 kW + W 283° · 22° · 6.6 kW');
    });

    it('wraps north and appends the clip limit', () => {
        expect(describePlanes({ planes: [{ azimuth: 355, tilt: 10, dcKwp: 2 }], acClipKw: 7.68 }))
            .toBe('N 355° · 10° · 2.0 kW (clip 7.7 kW)');
    });

    it('shows a dash with no planes', () => {
        expect(describePlanes({ planes: [], acClipKw: null })).toBe('—');
    });
});
