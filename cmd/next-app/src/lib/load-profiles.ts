import raw from './load-profiles.json';

export type LoadGlyph = 'car' | 'appliance' | 'small';

const GLYPHS: readonly LoadGlyph[] = ['car', 'appliance', 'small'];

export interface LoadProfile {
    id: string;
    label: string;
    kwh: number;          // energy the load consumes
    headroomKwh: number;  // surplus needed before the glyph green-lights it
    glyph: LoadGlyph;
}

/**
 * Validates and normalises the profile table. Throws on a malformed file so a
 * bad edit fails the build instead of rendering a broken UI.
 *
 * Note what is deliberately NOT validated: glyph uniqueness. Several profiles
 * sharing one glyph (a big car and a little car) is the expected case.
 */
export function parseLoadProfiles(rawInput: unknown): LoadProfile[] {
    const profiles = (rawInput as { profiles?: unknown })?.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) {
        throw new Error('load-profiles: "profiles" must be a non-empty array');
    }

    const seen = new Set<string>();
    const parsed = profiles.map((entry, index) => {
        const p = entry as Partial<LoadProfile>;
        const where = `load-profiles[${index}]`;

        if (typeof p.id !== 'string' || p.id.length === 0) {
            throw new Error(`${where}: id must be a non-empty string`);
        }
        if (seen.has(p.id)) {
            throw new Error(`${where}: duplicate id "${p.id}"`);
        }
        seen.add(p.id);

        if (typeof p.label !== 'string' || p.label.length === 0) {
            throw new Error(`${where}: label must be a non-empty string`);
        }
        if (typeof p.kwh !== 'number' || !(p.kwh > 0)) {
            throw new Error(`${where}: kwh must be a positive number`);
        }
        if (typeof p.headroomKwh !== 'number' || !(p.headroomKwh > 0)) {
            throw new Error(`${where}: headroomKwh must be a positive number`);
        }
        if (p.headroomKwh < p.kwh) {
            throw new Error(`${where}: headroomKwh (${p.headroomKwh}) must be >= kwh (${p.kwh})`);
        }
        if (!GLYPHS.includes(p.glyph as LoadGlyph)) {
            throw new Error(`${where}: glyph must be one of ${GLYPHS.join(', ')}`);
        }

        return { id: p.id, label: p.label, kwh: p.kwh, headroomKwh: p.headroomKwh, glyph: p.glyph as LoadGlyph };
    });

    return parsed.sort((a, b) => b.headroomKwh - a.headroomKwh);
}

export const LOAD_PROFILES: LoadProfile[] = parseLoadProfiles(raw);

export const MAX_PROFILE_KWH: number = Math.max(...LOAD_PROFILES.map(p => p.kwh));
