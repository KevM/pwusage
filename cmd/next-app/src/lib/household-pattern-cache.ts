import type { LoadPlanningContext, LoadPlanningSlot } from './load-planning-context';
import type { GridHistory, GridHistorySlot } from './load-planning-grid-history';

export type HouseholdPatternSlot = LoadPlanningSlot & Omit<GridHistorySlot, 'localMinute'>;

export interface HouseholdPattern extends Omit<LoadPlanningContext, 'slots'> {
    gridHistory: Omit<GridHistory, 'slots'>;
    slots: HouseholdPatternSlot[];
}

interface Entry {
    key: string;
    pattern: HouseholdPattern;
}

const cache = new Map<string, Entry>();

/**
 * Memoises a site's household pattern, which is built from complete local
 * days only and so changes at site-local midnight. Cached per running
 * instance, keyed by the history window's end, so a warm instance reads the
 * 28 days of history once per site per day.
 */
export async function getCachedHouseholdPattern(
    siteId: string,
    historyEnd: Date,
    load: () => Promise<HouseholdPattern>
): Promise<HouseholdPattern> {
    const key = historyEnd.toISOString();
    const hit = cache.get(siteId);
    if (hit && hit.key === key) return hit.pattern;

    // Awaited before caching so a failed load is never memoised.
    const pattern = await load();
    cache.set(siteId, { key, pattern });
    return pattern;
}

export function clearHouseholdPatternCache(): void {
    cache.clear();
}
