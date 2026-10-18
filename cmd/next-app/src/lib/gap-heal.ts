import { SiteRepo } from './site-repo';
import { Importer } from './importer';
import { createTeslaClientForSite } from './tesla-client-factory';
import { addDaysInSiteTimezone, getSiteMidnight } from './date-utils';

/**
 * Bounded trailing-window heal for EnergyData gaps.
 *
 * The web dashboard only heals the date range being viewed (DataSyncer →
 * /api/sync), and the today refresh only covers today plus yesterday's tail, so
 * older holes (whole missing days, interior gaps) were never healed for sites
 * only used from iOS. That broke the 14-day load-planning profile. This walks
 * each eligible site's trailing complete site-local days through
 * ensureDataForRange (planImport under the import lock), capped per site and
 * by a shared time budget sized for the Vercel Hobby 60s function limit.
 * Unhealed windows are simply re-planned by the next run.
 */
export interface HealTrailingGapsOptions {
    days?: number;
    maxWindowsPerSite?: number;
    maxTimeMs?: number;
    now?: () => Date;
    clock?: () => number;
}

export type HealSiteResult =
    | { siteId: string; status: 'complete' | 'partial'; processedWindows: number; totalWindows: number }
    | { siteId: string; status: 'no-tokens' | 'busy' }
    | { siteId: string; status: 'error'; errorMessage: string };

export interface HealTrailingGapsResult {
    sites: HealSiteResult[];
    stopped?: 'time-budget';
}

export const GAP_HEAL_DAYS = 14;
export const GAP_HEAL_MAX_WINDOWS_PER_SITE = 3;
export const GAP_HEAL_MAX_TIME_MS = 35_000;

export async function healTrailingGaps(options: HealTrailingGapsOptions = {}): Promise<HealTrailingGapsResult> {
    const days = options.days ?? GAP_HEAL_DAYS;
    const maxWindows = options.maxWindowsPerSite ?? GAP_HEAL_MAX_WINDOWS_PER_SITE;
    const maxTimeMs = options.maxTimeMs ?? GAP_HEAL_MAX_TIME_MS;
    const now = options.now ?? (() => new Date());
    const clock = options.clock ?? Date.now;

    const startedAt = clock();
    const sites = await new SiteRepo().getSitesForGapHeal();
    const result: HealTrailingGapsResult = { sites: [] };

    for (const site of sites) {
        const remainingMs = maxTimeMs - (clock() - startedAt);
        if (remainingMs <= 0) {
            result.stopped = 'time-budget';
            break;
        }
        result.sites.push(await healSite(site, days, maxWindows, remainingMs, now()));
    }
    return result;
}

async function healSite(
    site: { id: string; timezone: string },
    days: number,
    maxWindows: number,
    maxTimeMs: number,
    now: Date
): Promise<HealSiteResult> {
    try {
        const client = await createTeslaClientForSite(site.id);
        if (!client) return { siteId: site.id, status: 'no-tokens' };

        // Today belongs to refreshTodayData; heal only complete days.
        const end = getSiteMidnight(now, site.timezone);
        const start = addDaysInSiteTimezone(end, -days, site.timezone);
        const res = await new Importer(client).ensureDataForRange(site.id, start, end, undefined, { maxTimeMs, maxWindows });

        // ensureDataForRange reports a busy import lock as an empty, incomplete result.
        if (!res.complete && res.totalWindows === 0) return { siteId: site.id, status: 'busy' };
        return {
            siteId: site.id,
            status: res.complete ? 'complete' : 'partial',
            processedWindows: res.processedWindows,
            totalWindows: res.totalWindows,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[GapHeal] site ${site.id} failed: ${errorMessage}`);
        return { siteId: site.id, status: 'error', errorMessage };
    }
}
