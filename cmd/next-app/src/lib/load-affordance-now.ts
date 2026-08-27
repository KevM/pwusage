import { glyphForHeadroom, profileForHeadroom } from './load-affordance';
import { LOAD_PROFILES, type LoadGlyph, type LoadProfile } from './load-profiles';
import { formatTouName } from './format-utils';
import type { LoadTimingView } from './load-timing';

export interface LoadAffordanceNowView {
    /** Same glyph the header strip shows, so the two can never disagree. */
    glyph: LoadGlyph | null;
    /** The largest load the surplus affords, or the warning when none does. */
    headline: string;
    /** Active period and its banked surplus — the header glyph's tooltip text. */
    contextLabel: string;
    /** What the next load up is still short of; null once the biggest is covered. */
    nextUpLabel: string | null;
}

/**
 * The live page's version of the header strip's load-headroom glyph: the same
 * `profileForHeadroom` verdict, given the room to name the load, the period and
 * the surplus behind it instead of hiding them in a tooltip.
 *
 * Deliberately says nothing about cost. What a load would cost here, in this
 * period versus the next one, is the Load-timing card's "Can I run this now?"
 * widget; this is only the at-a-glance verdict.
 */
export function buildLoadAffordanceNow(
    loadTiming: LoadTimingView | null | undefined,
    profiles: LoadProfile[] = LOAD_PROFILES
): LoadAffordanceNowView | null {
    const active = loadTiming?.pricingPeriods.find(p => p.isActive);
    if (!active) return null;

    const surplusKwh = active.cycleNetExportKwh;
    const best = profileForHeadroom(surplusKwh, profiles);

    // Profiles are sorted by headroom descending, so the last one still out of
    // reach is the cheapest step up from where the surplus stands.
    const nextUp = [...profiles].reverse().find(p => p.headroomKwh > surplusKwh) ?? null;

    const surplusLabel = surplusKwh < 0
        ? `${Math.round(-surplusKwh)} kWh short`
        : `${Math.round(surplusKwh)} kWh surplus`;

    return {
        glyph: glyphForHeadroom(surplusKwh, profiles),
        headline: best?.label ?? 'Avoid large loads',
        contextLabel: `${formatTouName(active.name)} · ${surplusLabel}`,
        nextUpLabel: nextUp
            ? `${nextUp.label} needs ${Math.round(nextUp.headroomKwh - surplusKwh)} kWh more`
            : null,
    };
}
