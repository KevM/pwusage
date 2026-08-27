import { describe, expect, it } from 'vitest';
import { costToRun, glyphForHeadroom, profileForHeadroom } from './load-affordance';
import type { LoadProfile } from './load-profiles';

const peak = { surplusKwh: 10, buyRate: 0.48, sellRate: 0.12 };
const offPeak = { surplusKwh: 120, buyRate: 0.15, sellRate: 0.03 };

const fixture: LoadProfile[] = [
    { id: 'big', label: 'Big car', kwh: 100, headroomKwh: 160, glyph: 'car' },
    { id: 'small', label: 'Little car', kwh: 60, headroomKwh: 100, glyph: 'car' },
    { id: 'laundry', label: 'Laundry', kwh: 8, headroomKwh: 20, glyph: 'appliance' },
];

describe('costToRun', () => {
    it('prices a car charge that outruns the surplus at the buy rate', () => {
        const c = costToRun(60, peak);
        expect(c.coveredKwh).toBe(10);
        expect(c.boughtKwh).toBe(50);
        expect(c.total).toBeCloseTo(25.2, 6);
        expect(c.verdict).toBe('partial');
    });

    it('prices the same charge entirely at the sell rate when surplus is ample', () => {
        const c = costToRun(60, offPeak);
        expect(c.boughtKwh).toBe(0);
        expect(c.total).toBeCloseTo(1.8, 6);
        expect(c.verdict).toBe('covered');
    });

    it('reports tight when the load is affordable but eats the headroom', () => {
        const tight = costToRun(60, { surplusKwh: 70, buyRate: 0.48, sellRate: 0.12 }, 100);
        const covered = costToRun(60, { surplusKwh: 120, buyRate: 0.48, sellRate: 0.12 }, 100);
        expect(tight.verdict).toBe('tight');
        expect(covered.verdict).toBe('covered');
        // The whole point: identical dollars, different judgement.
        expect(tight.total).toBeCloseTo(covered.total, 6);
    });

    it('collapses tight into covered when no headroom is supplied', () => {
        const c = costToRun(60, { surplusKwh: 70, buyRate: 0.48, sellRate: 0.12 });
        expect(c.verdict).toBe('covered');
    });

    it('prices everything at the buy rate in deficit', () => {
        const c = costToRun(5, { surplusKwh: -20, buyRate: 0.48, sellRate: 0.12 });
        expect(c.coveredKwh).toBe(0);
        expect(c.boughtKwh).toBe(5);
        expect(c.total).toBeCloseTo(2.4, 6);
        expect(c.verdict).toBe('bought');
    });

    it('treats a zero surplus as bought', () => {
        expect(costToRun(5, { surplusKwh: 0, buyRate: 0.48, sellRate: 0.12 }).verdict).toBe('bought');
    });

    it('handles a zero sell rate without inventing cost', () => {
        const c = costToRun(5, { surplusKwh: 50, buyRate: 0.48, sellRate: 0 });
        expect(c.total).toBe(0);
    });
});

describe('profileForHeadroom', () => {
    it('selects the largest profile the surplus clears', () => {
        expect(profileForHeadroom(200, fixture)?.id).toBe('big');
        expect(profileForHeadroom(120, fixture)?.id).toBe('small');
        expect(profileForHeadroom(25, fixture)?.id).toBe('laundry');
    });

    it('resolves distinct profiles where the glyph is identical', () => {
        expect(profileForHeadroom(200, fixture)?.label).toBe('Big car');
        expect(profileForHeadroom(120, fixture)?.label).toBe('Little car');
        expect(glyphForHeadroom(200, fixture)).toBe('car');
        expect(glyphForHeadroom(120, fixture)).toBe('car');
    });

    it('is inclusive at the threshold', () => {
        expect(profileForHeadroom(160, fixture)?.id).toBe('big');
        expect(profileForHeadroom(159.9, fixture)?.id).toBe('small');
    });

    it('returns null below the smallest threshold', () => {
        expect(profileForHeadroom(19, fixture)).toBeNull();
        expect(profileForHeadroom(0, fixture)).toBeNull();
        expect(profileForHeadroom(-30, fixture)).toBeNull();
        expect(glyphForHeadroom(-30, fixture)).toBeNull();
    });

    it('returns null for an empty profile table', () => {
        expect(profileForHeadroom(500, [])).toBeNull();
    });
});
