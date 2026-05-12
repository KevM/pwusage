import { describe, expect, it } from 'vitest';
import { formatTouName, formatTimeRange, formatCentsPerKwh, formatCentsPerKwhShort } from './format-utils';

describe('format-utils', () => {
    describe('formatTouName', () => {
        it('formats ALL_CAPS_WITH_UNDERSCORES to title case with hyphens', () => {
            expect(formatTouName('OFF_PEAK')).toBe('Off-Peak');
            expect(formatTouName('SUPER_OFF_PEAK')).toBe('Super-Off-Peak');
        });

        it('returns unformatted string if not enum-like', () => {
            expect(formatTouName('Regular String')).toBe('Regular String');
            expect(formatTouName('')).toBe('');
        });
    });

    describe('formatTimeRange', () => {
        it('returns "All Day" when both from and to are null', () => {
            expect(formatTimeRange(null, null, null, null)).toBe('All Day');
        });

        it('formats normal ranges', () => {
            expect(formatTimeRange(8, 30, 16, 0)).toBe('08:30 - 16:00');
        });

        it('handles null end hour as Midnight', () => {
            expect(formatTimeRange(20, 0, null, null)).toBe('20:00 - Midnight');
        });
    });

    describe('formatCentsPerKwh', () => {
        it('formats positive decimal dollars to cents per kWh', () => {
            expect(formatCentsPerKwh(0.10)).toBe('10¢ per kWh');
            expect(formatCentsPerKwh(0.04)).toBe('4¢ per kWh');
            expect(formatCentsPerKwh(0.125)).toBe('12.5¢ per kWh');
        });

        it('formats zero correctly', () => {
            expect(formatCentsPerKwh(0)).toBe('0¢ per kWh');
        });

        it('formats negative dollars correctly', () => {
            expect(formatCentsPerKwh(-0.05)).toBe('-5¢ per kWh');
        });
    });

    describe('formatCentsPerKwhShort', () => {
        it('formats positive decimal dollars to cents/kWh', () => {
            expect(formatCentsPerKwhShort(0.10)).toBe('10¢/kWh');
            expect(formatCentsPerKwhShort(0.04)).toBe('4¢/kWh');
            expect(formatCentsPerKwhShort(0.125)).toBe('12.5¢/kWh');
        });
    });
});
