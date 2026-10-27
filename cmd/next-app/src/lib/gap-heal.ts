import { SiteRepo } from './site-repo';
import { EnergyRepo } from './energy-repo';
import { Importer, planMissingWindows } from './importer';
import { createTeslaClientForSite } from './tesla-client-factory';
import { addDaysInSiteTimezone, getSiteMidnight } from './date-utils';
import { flushLogEvents, logEvent } from './observability';

/**
 * Bounded trailing-window heal for day-record gaps.
 *
 * The web dashboard only heals the date range being viewed (DataSyncer →
 * /api/sync), and the today refresh only covers today plus yesterday's tail, so
 * older holes (whole missing days, interior gaps) were never healed for sites
 * only used from iOS. That broke the 14-day load-planning profile. This walks
 * each recently used or recovered site's trailing complete site-local days through
 * ensureDataForRange (planImport under the import lock), capped per site and
 * by a shared time budget sized for the Vercel Hobby 60s function limit.
 * Unhealed windows are simply re-planned by the next run. Settled day records
 * count as covered, so they are not re-fetched.
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
    /** Recently used or recovered sites whose trailing window was checked. */
    checked: number;
    /** Only sites whose window was short of samples; complete sites are omitted. */
    sites: HealSiteResult[];
    stopped?: 'time-budget';
}

export const GAP_HEAL_DAYS = 14;
export const GAP_HEAL_MAX_WINDOWS_PER_SITE = 3;
export const GAP_HEAL_MAX_TIME_MS = 35_000;
/** Idle sites are left alone unless their last auth outage ended recently. */
export const GAP_HEAL_ACTIVE_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
export const GAP_HEAL_RECOVERED_WITHIN_MS = GAP_HEAL_DAYS * 24 * 60 * 60 * 1000;

export async function healTrailingGaps(options: HealTrailingGapsOptions = {}): Promise<HealTrailingGapsResult> {
    const days = options.days ?? GAP_HEAL_DAYS;
    const maxWindows = options.maxWindowsPerSite ?? GAP_HEAL_MAX_WINDOWS_PER_SITE;
    const maxTimeMs = options.maxTimeMs ?? GAP_HEAL_MAX_TIME_MS;
    const now = options.now ?? (() => new Date());
    const clock = options.clock ?? Date.now;

    const startedAt = clock();
    const at = now();
    const sites = await new SiteRepo().getSitesForGapHeal(
        at.getTime() - GAP_HEAL_ACTIVE_WITHIN_MS,
        at.getTime() - GAP_HEAL_RECOVERED_WITHIN_MS,
    );
    const windows = sites.map(site => trailingWindow(site, days, at));

    // Egress: one small count query covers every site. Only sites short of a
    // full set of 5-minute samples pay for tokens, the site load, the import
    // lock and the per-day coverage audit (planImport) that decides what to fetch.
    const counts = await EnergyRepo.countAlignedSamples(
        windows.map(w => ({ siteId: w.site.id, start: w.countStart, end: w.end })));
    const result: HealTrailingGapsResult = { checked: sites.length, sites: [] };
    for (const w of windows) {
        const fields = siteLogFields(w, at);
        if ((counts.get(w.site.id) ?? 0) >= (w.end.getTime() - w.countStart.getTime()) / SLOT_MS) {
            // Recovered sites with full coverage also need an observable outcome,
            // without paying for a coverage audit, tokens or a Tesla request.
            if (fields.recovering) {
                logEvent('info', 'cron.heal-gaps.site', { ...fields, outcome: 'complete', processedWindows: 0, totalWindows: 0 });
                flushLogEvents();
            }
            continue;
        }
        const remainingMs = maxTimeMs - (clock() - startedAt);
        if (remainingMs <= 0) {
            result.stopped = 'time-budget';
            break;
        }
        logEvent('info', 'cron.heal-gaps.site.started', { ...fields, maxWindows });
        flushLogEvents();
        const siteResult = await healSite(w.site, w.start, w.end, maxWindows, remainingMs);
        result.sites.push(siteResult);
        logEvent(siteResult.status === 'error' ? 'warn' : 'info', 'cron.heal-gaps.site', {
            ...fields, outcome: siteResult.status,
            ...('processedWindows' in siteResult ? {
                processedWindows: siteResult.processedWindows, totalWindows: siteResult.totalWindows,
            } : {}),
        });
        flushLogEvents();
    }
    return result;
}

const SLOT_MS = 5 * 60 * 1000;

type HealSite = { id: string; timezone: string; installed: Date; auth_lost_at?: Date | null; auth_restored_at?: Date | null };

interface TrailingWindow {
    site: HealSite;
    /** Window handed to ensureDataForRange; planImport clamps it to the install day. */
    start: Date;
    end: Date;
    /** Same clamp for counting, so a new site isn't always short. */
    countStart: Date;
}

function siteLogFields(window: TrailingWindow, at: Date) {
    const { site } = window;
    const lost = site.auth_lost_at;
    const restored = site.auth_restored_at;
    return {
        siteId: site.id,
        recovering: !!(lost && restored && +restored > +lost && +restored >= +at - GAP_HEAL_RECOVERED_WITHIN_MS),
        authLostAt: lost?.toISOString() ?? null,
        authRestoredAt: restored?.toISOString() ?? null,
        windowStart: window.countStart.toISOString(),
        windowEnd: window.end.toISOString(),
    };
}

function trailingWindow(site: HealSite, days: number, at: Date): TrailingWindow {
    // Today belongs to refreshTodayData; heal only complete days.
    const end = getSiteMidnight(at, site.timezone);
    const trailingStart = addDaysInSiteTimezone(end, -days, site.timezone);
    const start = outageStart(site, trailingStart) ?? trailingStart;
    const installMidnight = getSiteMidnight(new Date(site.installed), site.timezone);
    const countStart = installMidnight > start ? (installMidnight < end ? installMidnight : end) : start;
    return { site, start, end, countStart };
}

/**
 * After a re-auth within the window, reach back to the day access was lost so the
 * outage's missing and open days are fetched (the planner keeps them open for a
 * gap-heal window after the restore). A current outage has nothing to fetch with.
 */
function outageStart(site: HealSite, trailingStart: Date): Date | null {
    const { auth_lost_at: lost, auth_restored_at: restored } = site;
    if (!lost || !restored || +restored <= +lost || +restored < +trailingStart) return null;
    const lostMidnight = getSiteMidnight(lost, site.timezone);
    return lostMidnight < trailingStart ? lostMidnight : null;
}

async function healSite(
    site: HealSite,
    start: Date,
    end: Date,
    maxWindows: number,
    maxTimeMs: number
): Promise<HealSiteResult> {
    const siteId = site.id;
    try {
        // A short count can come from gaps under planImport's thresholds, which it
        // never fetches. Audit first so those sites skip tokens, the site load and the lock.
        if ((await planMissingWindows(site, start, end)).length === 0) {
            return { siteId, status: 'complete', processedWindows: 0, totalWindows: 0 };
        }

        const client = await createTeslaClientForSite(siteId);
        if (!client) return { siteId, status: 'no-tokens' };

        const res = await new Importer(client).ensureDataForRange(siteId, start, end, undefined, { maxTimeMs, maxWindows });

        // ensureDataForRange reports a busy import lock as an empty, incomplete result.
        if (!res.complete && res.totalWindows === 0) return { siteId, status: 'busy' };
        return {
            siteId,
            status: res.complete ? 'complete' : 'partial',
            processedWindows: res.processedWindows,
            totalWindows: res.totalWindows,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[GapHeal] site ${siteId} failed: ${errorMessage}`);
        return { siteId, status: 'error', errorMessage };
    }
}
