import type { UsageData } from './energy-repo';

interface Entry {
    key: string;
    rows: UsageData[];
}

const cache = new Map<string, Entry>();

/**
 * Memoises the completed-days portion of the cycle rollup, which only changes
 * at site-local midnight. Cached per running instance, so a warm instance pays
 * the query once per site per day.
 */
export async function getCachedCycleRollup(
    siteId: string,
    cycleStart: Date,
    siteMidnight: Date,
    load: () => Promise<UsageData[]>
): Promise<UsageData[]> {
    const key = `${cycleStart.toISOString()}|${siteMidnight.toISOString()}`;
    const hit = cache.get(siteId);
    if (hit && hit.key === key) return hit.rows;

    // Awaited before caching so a failed load is never memoised.
    const rows = await load();
    cache.set(siteId, { key, rows });
    return rows;
}

export function clearCycleRollupCache(): void {
    cache.clear();
}
