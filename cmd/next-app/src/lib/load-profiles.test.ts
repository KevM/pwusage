import { describe, expect, it } from 'vitest';
import { LOAD_PROFILES, MAX_PROFILE_KWH, parseLoadProfiles } from './load-profiles';

const valid = {
    profiles: [
        { id: 'a', label: 'A', kwh: 10, headroomKwh: 20, glyph: 'car' },
        { id: 'b', label: 'B', kwh: 5, headroomKwh: 40, glyph: 'appliance' },
    ],
};

describe('parseLoadProfiles', () => {
    it('sorts profiles by headroomKwh descending', () => {
        const parsed = parseLoadProfiles(valid);
        expect(parsed.map(p => p.id)).toEqual(['b', 'a']);
    });

    it('accepts two profiles sharing a glyph', () => {
        const parsed = parseLoadProfiles({
            profiles: [
                { id: 'big', label: 'Big car', kwh: 100, headroomKwh: 160, glyph: 'car' },
                { id: 'small', label: 'Little car', kwh: 60, headroomKwh: 100, glyph: 'car' },
            ],
        });
        expect(parsed).toHaveLength(2);
        expect(parsed.every(p => p.glyph === 'car')).toBe(true);
    });

    it('rejects headroomKwh below kwh', () => {
        expect(() => parseLoadProfiles({
            profiles: [{ id: 'a', label: 'A', kwh: 50, headroomKwh: 10, glyph: 'car' }],
        })).toThrow(/headroomKwh/);
    });

    it('rejects a duplicate id', () => {
        expect(() => parseLoadProfiles({
            profiles: [
                { id: 'a', label: 'A', kwh: 5, headroomKwh: 5, glyph: 'small' },
                { id: 'a', label: 'B', kwh: 6, headroomKwh: 6, glyph: 'small' },
            ],
        })).toThrow(/duplicate/i);
    });

    it('rejects a non-positive kwh', () => {
        expect(() => parseLoadProfiles({
            profiles: [{ id: 'a', label: 'A', kwh: 0, headroomKwh: 5, glyph: 'small' }],
        })).toThrow(/kwh/);
    });

    it('rejects an unknown glyph', () => {
        expect(() => parseLoadProfiles({
            profiles: [{ id: 'a', label: 'A', kwh: 5, headroomKwh: 5, glyph: 'rocket' }],
        })).toThrow(/glyph/);
    });

    it('rejects a missing label', () => {
        expect(() => parseLoadProfiles({
            profiles: [{ id: 'a', kwh: 5, headroomKwh: 5, glyph: 'small' }],
        })).toThrow(/label/);
    });
});

describe('shipped profiles', () => {
    it('loads and is sorted descending by headroomKwh', () => {
        expect(LOAD_PROFILES.length).toBeGreaterThan(0);
        const headrooms = LOAD_PROFILES.map(p => p.headroomKwh);
        expect([...headrooms].sort((a, b) => b - a)).toEqual(headrooms);
    });

    it('exposes the largest load size as MAX_PROFILE_KWH', () => {
        expect(MAX_PROFILE_KWH).toBe(Math.max(...LOAD_PROFILES.map(p => p.kwh)));
    });
});
