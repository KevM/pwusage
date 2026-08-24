import { LOAD_PROFILES, type LoadGlyph, type LoadProfile } from './load-profiles';

export interface PeriodPricing {
    surplusKwh: number;   // cycle net export for the period; negative means deficit
    buyRate: number;
    sellRate: number;
}

export type LoadVerdict = 'covered' | 'tight' | 'partial' | 'bought' | 'unknown';

export interface LoadCost {
    total: number;
    coveredKwh: number;   // priced at the sell rate
    boughtKwh: number;    // priced at the buy rate
    verdict: LoadVerdict;
}

/**
 * What a load of `loadKwh` costs in a period right now.
 *
 * The portion the period's banked surplus absorbs is priced at the sell rate
 * (you give up an export); the remainder is priced at the buy rate. That cliff
 * is why a 60 kWh car charge can cost $25 in Peak and $1.80 in Off-peak.
 *
 * `headroomKwh` only affects the verdict, never the dollars: a load can be
 * entirely sell-rate priced and still drain the buffer that has to last the
 * rest of the cycle. Omit it (a custom slider amount) and `tight` collapses
 * into `covered`.
 */
export function costToRun(loadKwh: number, pricing: PeriodPricing, headroomKwh?: number): LoadCost {
    const surplus = Math.max(pricing.surplusKwh, 0);
    const coveredKwh = Math.min(loadKwh, surplus);
    const boughtKwh = loadKwh - coveredKwh;
    const total = coveredKwh * pricing.sellRate + boughtKwh * pricing.buyRate;

    let verdict: LoadVerdict;
    if (coveredKwh === 0) {
        verdict = 'bought';
    } else if (boughtKwh > 0) {
        verdict = 'partial';
    } else if (headroomKwh !== undefined && pricing.surplusKwh < headroomKwh) {
        verdict = 'tight';
    } else {
        verdict = 'covered';
    }

    return { total, coveredKwh, boughtKwh, verdict };
}

/**
 * The largest load the surplus comfortably affords. `profiles` is pre-sorted
 * by headroom descending, so the first match wins.
 */
export function profileForHeadroom(
    surplusKwh: number,
    profiles: LoadProfile[] = LOAD_PROFILES
): LoadProfile | null {
    return profiles.find(p => surplusKwh >= p.headroomKwh) ?? null;
}

export function glyphForHeadroom(
    surplusKwh: number,
    profiles: LoadProfile[] = LOAD_PROFILES
): LoadGlyph | null {
    return profileForHeadroom(surplusKwh, profiles)?.glyph ?? null;
}
