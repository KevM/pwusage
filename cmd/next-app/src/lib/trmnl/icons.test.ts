import { describe, it, expect } from 'vitest';
import { getSunIcon, getGridIcon, getChargingIcon, getDischargingIcon } from './icons';

describe('Trmnl Icons', () => {
    it('returns SVG string for sun icon at given size', () => {
        const svg = getSunIcon(40);
        expect(svg).toContain('<svg');
        expect(svg).toContain('width="40"');
        expect(svg).toContain('height="40"');
    });

    it('returns different sized sun icon', () => {
        const svg = getSunIcon(72);
        expect(svg).toContain('width="72"');
        expect(svg).toContain('height="72"');
    });

    it('returns SVG string for grid icon at given size', () => {
        const svg = getGridIcon(40);
        expect(svg).toContain('<svg');
        expect(svg).toContain('width="40"');
    });

    it('returns SVG for charging icon at given size', () => {
        const svg = getChargingIcon(32);
        expect(svg).toContain('<svg');
        expect(svg).toContain('width="32"');
    });

    it('returns SVG for discharging icon at given size', () => {
        const svg = getDischargingIcon(32);
        expect(svg).toContain('<svg');
        expect(svg).toContain('width="32"');
    });
});
