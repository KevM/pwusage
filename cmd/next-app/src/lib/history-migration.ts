/**
 * Site history migration: backfill raw EnergyData back to Site.installed, then
 * finalize every finished day before the 2-day floor into the compact archive.
 * Deletes nothing. Kept free of CLI/process concerns so a cron route can reuse
 * it for new-site onboarding (see the 2026-10-19 history migration spec).
 */
import { addDaysInSiteTimezone, formatSiteDate, getSiteMidnight } from './date-utils';
import { archiveCutoff } from './history-archive-service';
import type { EnsureDataResult } from './importer';
import type { DateWindow } from './importer/import-planner';
import {
    runCompactMaintenance,
    type MaintenanceDay,
    type MaintenanceStore,
} from './prototypes/compact-history-maintenance';

/** Per-pass budget for Importer.ensureDataForRange (newest windows first). */
const BACKFILL_BUDGET = { maxTimeMs: 45000, maxWindows: 30 };
/** The archive's floor: the two most recent finished days stay raw-only. */
const ARCHIVE_FLOOR_DAYS = 2;
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

export interface MigrationSite {
    id: string;
    timezone: string;
    installed: Date;
}

export interface BackfillDeps {
    plan(site: MigrationSite, start: Date, end: Date): Promise<DateWindow[]>;
    ensure(siteId: string, start: Date, end: Date, budget: { maxTimeMs: number; maxWindows: number }): Promise<EnsureDataResult>;
}

export interface BackfillSummary {
    passes: number;
    windowsImported: number;
    /** Local dates of day windows still planned (missing or incomplete) at the end. */
    missingDays: string[];
    stopped: 'complete' | 'no-progress' | 'busy' | 'preview' | 'nothing-to-do';
}

/**
 * Backfill raw history for [installed site midnight, end) in budgeted
 * `ensure` passes, re-planning after each. Days Tesla never fills stay
 * planned forever, so a pass that doesn't shrink the plan ends the loop
 * ('no-progress') instead of spinning. An `ensure` throw (every window in a
 * pass failed) propagates.
 */
export async function backfillSiteHistory(
    deps: BackfillDeps,
    site: MigrationSite,
    end: Date,
    apply: boolean,
    maxPasses = 200
): Promise<BackfillSummary> {
    const start = getSiteMidnight(site.installed, site.timezone);
    const summary: BackfillSummary = { passes: 0, windowsImported: 0, missingDays: [], stopped: 'nothing-to-do' };
    if (start >= end) return summary;

    let planned = await deps.plan(site, start, end);
    const finish = (stopped: BackfillSummary['stopped']) => ({
        ...summary,
        missingDays: planned.map(w => formatSiteDate(w.start, site.timezone)),
        stopped,
    });
    if (!apply) return finish('preview');

    while (planned.length > 0) {
        if (summary.passes >= maxPasses) return finish('no-progress');
        const result = await deps.ensure(site.id, start, end, BACKFILL_BUDGET);
        summary.passes++;
        summary.windowsImported += result.processedWindows;
        // 0/0 with work outstanding means the site's import lock is held elsewhere.
        if (result.processedWindows === 0 && result.totalWindows === 0) return finish('busy');
        const next = await deps.plan(site, start, end);
        const progressed = next.length < planned.length;
        planned = next;
        if (!progressed) return finish('no-progress');
    }
    return finish('complete');
}

export interface SiteMigrationReport {
    mode: 'preview' | 'apply';
    installed: string;
    cutoff: string;
    backfill: BackfillSummary | 'skipped';
    archive: ArchiveSummary | 'skipped';
    rawDeletionPerformed: false;
}

/**
 * Migrate one site: backfill raw history back to install, then archive every
 * finished day before the 2-day floor. Both steps end at the same cutoff so
 * the script never contends with today-refresh or gap-heal on recent days.
 * Archiving runs even when backfill stops early: archiving what is present is
 * safe, and a later raw write to an archived day invalidates that archive.
 */
export async function migrateSiteHistory(
    deps: { site: MigrationSite; backfill: BackfillDeps; store: MaintenanceStore },
    options: { apply: boolean; now: Date; skipBackfill?: boolean; skipArchive?: boolean }
): Promise<SiteMigrationReport> {
    const { site } = deps;
    const cutoff = archiveCutoff(options.now, site.timezone, ARCHIVE_FLOOR_DAYS);
    const backfill = options.skipBackfill
        ? 'skipped'
        : await backfillSiteHistory(deps.backfill, site, cutoff, options.apply);
    const archive = options.skipArchive
        ? 'skipped'
        : await archiveSiteHistory(deps.store, {
            siteId: site.id,
            start: getSiteMidnight(site.installed, site.timezone),
            end: cutoff,
            timezone: site.timezone,
            apply: options.apply,
            now: options.now,
        });
    return {
        mode: options.apply ? 'apply' : 'preview',
        installed: formatSiteDate(site.installed, site.timezone),
        cutoff: formatSiteDate(cutoff, site.timezone),
        backfill,
        archive,
        rawDeletionPerformed: false,
    };
}
