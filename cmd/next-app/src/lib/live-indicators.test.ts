import { describe, expect, it } from 'vitest';
import { getBatteryActivity } from './live-indicators';

describe('getBatteryActivity', () => {
    it('returns charging when battery power is below the charging threshold', () => {
        expect(getBatteryActivity(-101)).toBe('charging');
        expect(getBatteryActivity(-2500)).toBe('charging');
    });

    it('returns discharging when battery power is above the discharging threshold', () => {
        expect(getBatteryActivity(101)).toBe('discharging');
        expect(getBatteryActivity(3200)).toBe('discharging');
    });

    it('returns idle at and within threshold boundaries', () => {
        expect(getBatteryActivity(-100)).toBe('idle');
        expect(getBatteryActivity(0)).toBe('idle');
        expect(getBatteryActivity(100)).toBe('idle');
    });
});
