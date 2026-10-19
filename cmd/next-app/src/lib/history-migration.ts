/**
 * Site history migration: backfill raw EnergyData back to Site.installed, then
 * finalize every finished day before the 2-day floor into the compact archive.
 * Deletes nothing. Kept free of CLI/process concerns so a cron route can reuse
 * it for new-site onboarding (see the 2026-10-19 history migration spec).
 */
import { addDaysInSiteTimezone, formatSiteDate } from './date-utils';
import {
    runCompactMaintenance,
    type MaintenanceDay,
    type MaintenanceStore,
} from './prototypes/compact-history-maintenance';

/** Consecutive non-shrinking (busy) maintenance calls tolerated per chunk. */
const MAX_BUSY_ATTEMPTS = 3;

/**
 * Consecutive local `YYYY-MM-DD` ranges covering [start, end), each at most
 * `maxDays` site-local days. `start` and `end` are site-local midnights.
 */
export function localDayChunks(start: Date, end: Date, timezone: string, maxDays = 31): { from: string; before: string }[] {
    const chunks: { from: string; before: string }[] = [];
    let cursor = start;
    while (cursor < end) {
        let next = cursor;
        for (let days = 0; days < maxDays && next < end; days++) {
            next = addDaysInSiteTimezone(next, 1, timezone);
        }
        if (next > end) next = end;
        chunks.push({ from: formatSiteDate(cursor, timezone), before: formatSiteDate(next, timezone) });
        cursor = next;
    }
    return chunks;
}

export interface ArchiveSummary {
    chunks: number;
    archived: string[];
    alreadyArchived: number;
    empty: number;
    needsRepair: string[];
    incompleteAttribution: string[];
    remaining: string[];
    stopped: 'caught-up' | 'busy' | 'preview' | 'nothing-to-do';
}

/**
 * Drive `runCompactMaintenance` over [start, end) in ≤31-day chunks. Preview
 * makes one call per chunk; apply re-calls a chunk until nothing remains, and
 * stops the whole run after MAX_BUSY_ATTEMPTS calls in a row that make no
 * progress (the site advisory lock is held elsewhere).
 */
export async function archiveSiteHistory(
    store: MaintenanceStore,
    args: { siteId: string; start: Date; end: Date; timezone: string; apply: boolean; now: Date },
    maintain = runCompactMaintenance
): Promise<ArchiveSummary> {
    const chunks = localDayChunks(args.start, args.end, args.timezone);
    const days = new Map<string, MaintenanceDay>();
    const record = (reported: MaintenanceDay[]) => {
        for (const day of reported) {
            // A day finalized earlier in this run reads back as 'archived' on a
            // re-call; keep crediting it as archived by this run.
            if (days.get(day.date)?.status === 'finalized' && day.status === 'archived') continue;
            days.set(day.date, day);
        }
    };
    const remaining: string[] = [];
    let stopped: ArchiveSummary['stopped'] = chunks.length === 0 ? 'nothing-to-do' : args.apply ? 'caught-up' : 'preview';

    for (const chunk of chunks) {
        const options = { siteId: args.siteId, ...chunk, apply: args.apply, maxDays: 7, maxTimeMs: 45000, now: args.now };
        if (!args.apply) {
            const report = await maintain(store, options);
            record(report.days);
            remaining.push(...report.remaining);
            continue;
        }
        let stalls = 0;
        let previous = Infinity;
        for (;;) {
            const report = await maintain(store, options);
            record(report.days);
            if (report.remaining.length === 0) break;
            stalls = report.remaining.length < previous ? (report.stopped === 'busy' ? 1 : 0) : stalls + 1;
            previous = report.remaining.length;
            if (stalls >= MAX_BUSY_ATTEMPTS) {
                remaining.push(...report.remaining);
                stopped = 'busy';
                break;
            }
        }
        if (stopped === 'busy') break;
    }

    const all = [...days.values()];
    const dates = (keep: (d: MaintenanceDay) => boolean) => all.filter(keep).map(d => d.date);
    return {
        chunks: chunks.length,
        archived: dates(d => d.status === 'finalized'),
        alreadyArchived: all.filter(d => d.status === 'archived' || d.status === 'unchanged').length,
        empty: all.filter(d => d.status === 'empty').length,
        needsRepair: dates(d => d.needsRepair),
        incompleteAttribution: dates(d => d.attributionComplete === false),
        remaining,
        stopped,
    };
}
