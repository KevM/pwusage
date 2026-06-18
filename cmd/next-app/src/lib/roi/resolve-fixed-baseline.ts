import { type ComparisonStructure } from './comparison-tariff-repo';
import { classifyTariff } from './classify-tariff';

/** Pick the date-resolvable Fixed baseline: the comparison plan whose CURRENT version
 *  (tariffs[0], newest-first per listComparisonStructures) classifies as Fixed, choosing
 *  the most-recent current effective_from. Returns the FULL structure (all versions) so the
 *  caller can date-resolve it via comparisonStructTimeline. Null ⇒ no Fixed plan (hero hidden). */
export function pickFixedBaselineStructure(structures: ComparisonStructure[]): ComparisonStructure | null {
    let best: { eff: string; s: ComparisonStructure } | null = null;
    for (const s of structures) {
        const current = s.tariffs[0];
        if (!current || classifyTariff(current) !== 'fixed') continue;
        const eff = current.effective_from ?? '0000-01-01';
        if (!best || eff > best.eff) best = { eff, s };
    }
    return best?.s ?? null;
}
