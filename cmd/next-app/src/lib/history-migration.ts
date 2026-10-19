/**
 * Site history migration: backfill raw EnergyData back to Site.installed, then
 * finalize every finished day before the 2-day floor into the compact archive.
 * Deletes nothing. Kept free of CLI/process concerns so a cron route can reuse
 * it for new-site onboarding (see the 2026-10-19 history migration spec).
 */
import { addDaysInSiteTimezone, formatSiteDate, getSiteMidnight, parseSiteLocalDateToMidnight } from './date-utils';
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
/** Consecutive busy attempts tolerated: per archive chunk, and per backfill pass. */
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
    /** Days with stored samples that are short, gappy or not fully attributed (never empty days). */
    repairable: string[];
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
        repairable: dates(d => d.status !== 'empty' && d.samples > 0 && (d.needsRepair || d.attributionComplete === false)),
        remaining,
        stopped,
    };
}

export interface MigrationSite {
    id: string;
    timezone: string;
    installed: Date;
    /**
     * Recorded first day worth backfilling (site-local midnight). Tesla's
     * installation date is the hardware install; data only starts once the
     * utility provisions the site, and the days between never fill.
     */
    backfillFrom?: Date | null;
}

export interface BackfillDeps {
    plan(site: MigrationSite, start: Date, end: Date): Promise<DateWindow[]>;
    ensure(siteId: string, start: Date, end: Date, budget: { maxTimeMs: number; maxWindows: number }): Promise<EnsureDataResult>;
    /**
     * Wait between passes. Each pass takes the site import lock and stamps
     * `last_import_at`, so back-to-back passes would starve the app's
     * today-refresh (it needs the lock free and its min interval elapsed).
     */
    pause(): Promise<void>;
    /** Persist the first day after the pre-provisioning gap (see MigrationSite.backfillFrom). */
    recordBackfillFrom(siteId: string, from: Date): Promise<void>;
    /** Re-import exactly these days, even if stored coverage looks complete (Importer.refetchDays). */
    refetch(siteId: string, days: DateWindow[], budget: { maxTimeMs: number; maxWindows: number }): Promise<EnsureDataResult>;
}

export interface BackfillSummary {
    passes: number;
    windowsImported: number;
    /** Local dates of day windows still planned (missing or incomplete) at the end. */
    missingDays: string[];
    /**
     * 'no-progress': every missing day came back from Tesla cleanly but still
     * empty or partial (nothing more to fetch). 'incomplete': stopped with days
     * that failed, were never attempted, or hit the pass limit; re-run.
     */
    stopped: 'complete' | 'no-progress' | 'incomplete' | 'busy' | 'preview' | 'nothing-to-do';
    /** Local date recorded this run as the new backfill start, if a pre-provisioning gap was confirmed. */
    backfillFrom: string | null;
}

/**
 * The day after the run of planned windows that starts exactly at `start`,
 * or null when there is no such run or it reaches `end` (no data at all).
 */
function afterLeadingRun(planned: DateWindow[], start: Date, end: Date): Date | null {
    const sorted = [...planned].sort((a, b) => +a.start - +b.start);
    if (sorted.length === 0 || +sorted[0].start !== +start) return null;
    let next = sorted[0].end;
    for (const window of sorted.slice(1)) {
        if (+window.start !== +next) break;
        next = window.end;
    }
    return next < end ? next : null;
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
    const installMidnight = getSiteMidnight(site.installed, site.timezone);
    const start = site.backfillFrom && site.backfillFrom > installMidnight ? site.backfillFrom : installMidnight;
    const summary: BackfillSummary = { passes: 0, windowsImported: 0, missingDays: [], stopped: 'nothing-to-do', backfillFrom: null };
    if (start >= end) return summary;

    // ensure imports the newest windows first, so a stuck newest batch would
    // hide older fillable days. Such a batch is set aside and the range ends
    // before it; set-aside days are still reported as missing.
    let passEnd = end;
    const setAside: DateWindow[] = [];
    let planned = await deps.plan(site, start, passEnd);
    const finish = (stopped: BackfillSummary['stopped']) => ({
        ...summary,
        missingDays: [...planned, ...setAside].sort((a, b) => +a.start - +b.start).map(w => formatSiteDate(w.start, site.timezone)),
        stopped,
    });
    if (!apply) return finish('preview');

    let busy = 0;
    let setAsideConfirmed = true;
    while (planned.length > 0) {
        if (summary.passes >= maxPasses) return finish('incomplete');
        if (summary.passes > 0) await deps.pause();
        const result = await deps.ensure(site.id, start, passEnd, BACKFILL_BUDGET);
        summary.passes++;
        summary.windowsImported += result.processedWindows;
        // 0/0 with work outstanding means the site's import lock is held elsewhere.
        if (result.processedWindows === 0 && result.totalWindows === 0) {
            if (++busy >= MAX_BUSY_ATTEMPTS) return finish('busy');
            continue;
        }
        busy = 0;
        const next = await deps.plan(site, start, passEnd);
        const progressed = next.length < planned.length;
        planned = next;
        if (progressed) continue;
        // The pass imported every window it took without error or timeout.
        const confirmed = result.processedWindows === Math.min(result.totalWindows, BACKFILL_BUDGET.maxWindows);
        if (planned.length > BACKFILL_BUDGET.maxWindows) {
            setAsideConfirmed &&= confirmed;
            const sorted = [...planned].sort((a, b) => +a.start - +b.start);
            const keep = sorted.length - BACKFILL_BUDGET.maxWindows;
            setAside.push(...sorted.slice(keep));
            planned = sorted.slice(0, keep);
            passEnd = sorted[keep].start;
            continue;
        }
        if (!confirmed) return finish('incomplete');
        // Every planned window was attempted and imported without error, yet
        // the leading days stay empty: Tesla has nothing before provisioning.
        // Remember that so later runs don't re-fetch (and re-archive) them.
        const from = afterLeadingRun(planned, start, passEnd);
        if (from) {
            await deps.recordBackfillFrom(site.id, from);
            summary.backfillFrom = formatSiteDate(from, site.timezone);
        }
        return finish(setAsideConfirmed ? 'no-progress' : 'incomplete');
    }
    if (setAside.length === 0) return finish('complete');
    return finish(setAsideConfirmed ? 'no-progress' : 'incomplete');
}

export interface RepairSummary {
    /** Local dates selected for re-fetch. */
    planned: string[];
    refetched: number;
    stopped: 'complete' | 'incomplete' | 'busy' | 'preview' | 'nothing-to-do';
    /** Planned dates still repairable after re-fetching and re-archiving. */
    stillNeedsRepair: string[];
}

/**
 * Re-fetch the given local dates from Tesla in budgeted batches, pausing
 * between batches (as backfill does) so today-refresh keeps the lock.
 */
export async function repairSiteDays(
    deps: Pick<BackfillDeps, 'refetch' | 'pause'>,
    site: MigrationSite,
    dates: string[],
    apply: boolean
): Promise<RepairSummary> {
    const summary: RepairSummary = { planned: dates, refetched: 0, stopped: 'complete', stillNeedsRepair: [] };
    if (dates.length === 0) return { ...summary, stopped: 'nothing-to-do' };
    if (!apply) return { ...summary, stopped: 'preview' };

    const windows = dates.map(date => {
        const start = parseSiteLocalDateToMidnight(date, site.timezone);
        return { start, end: addDaysInSiteTimezone(start, 1, site.timezone) };
    });
    let calls = 0;
    for (let i = 0; i < windows.length; i += BACKFILL_BUDGET.maxWindows) {
        const batch = windows.slice(i, i + BACKFILL_BUDGET.maxWindows);
        for (let busy = 0; ; ) {
            if (calls++ > 0) await deps.pause();
            const result = await deps.refetch(site.id, batch, BACKFILL_BUDGET);
            if (result.processedWindows === 0 && result.totalWindows === 0) {
                if (++busy >= MAX_BUSY_ATTEMPTS) return { ...summary, stopped: 'busy' };
                continue;
            }
            summary.refetched += result.processedWindows;
            if (result.processedWindows < batch.length) summary.stopped = 'incomplete';
            break;
        }
    }
    return summary;
}

export interface SiteMigrationReport {
    mode: 'preview' | 'apply';
    installed: string;
    cutoff: string;
    backfill: BackfillSummary | 'skipped';
    archive: ArchiveSummary | 'skipped';
    repair: RepairSummary | 'skipped';
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
    options: { apply: boolean; now: Date; skipBackfill?: boolean; skipArchive?: boolean; repair?: boolean }
): Promise<SiteMigrationReport> {
    const { site } = deps;
    const cutoff = archiveCutoff(options.now, site.timezone, ARCHIVE_FLOOR_DAYS);
    const backfill = options.skipBackfill
        ? 'skipped'
        : await backfillSiteHistory(deps.backfill, site, cutoff, options.apply);
    const runArchive = () => archiveSiteHistory(deps.store, {
        siteId: site.id,
        start: getSiteMidnight(site.installed, site.timezone),
        end: cutoff,
        timezone: site.timezone,
        apply: options.apply,
        now: options.now,
    });
    let archive: ArchiveSummary | 'skipped' = options.skipArchive ? 'skipped' : await runArchive();

    let repair: RepairSummary | 'skipped' = 'skipped';
    if (options.repair && archive !== 'skipped') {
        // Only days with real data worth re-fetching: on or after the backfill
        // start (never the pre-provisioning gap) and not ones Tesla can't fill.
        const installDate = formatSiteDate(site.installed, site.timezone);
        const from = [installDate, site.backfillFrom ? formatSiteDate(site.backfillFrom, site.timezone) : '',
            backfill === 'skipped' ? '' : backfill.backfillFrom ?? ''].reduce((a, b) => (b > a ? b : a));
        const unfillable = new Set(backfill === 'skipped' ? [] : backfill.missingDays);
        const planned = archive.repairable.filter(date => date >= from && !unfillable.has(date));
        repair = await repairSiteDays(deps.backfill, site, planned, options.apply);
        if (options.apply && repair.refetched > 0) {
            // Rewriting raw rows dropped those days' archives; rebuild them.
            const rebuilt = await runArchive();
            // An incomplete rebuild never audited the chunks it didn't reach, so a
            // day only counts as repaired once this pass rebuilt it cleanly.
            const repaired = (date: string) => !rebuilt.repairable.includes(date)
                && (rebuilt.stopped === 'caught-up' || rebuilt.archived.includes(date));
            repair.stillNeedsRepair = planned.filter(date => !repaired(date));
            archive = rebuilt;
        } else if (options.apply) {
            // Nothing was rewritten (lock busy or every refetch failed), so every planned day is still unresolved.
            repair.stillNeedsRepair = planned;
        }
    }
    return {
        mode: options.apply ? 'apply' : 'preview',
        installed: formatSiteDate(site.installed, site.timezone),
        cutoff: formatSiteDate(cutoff, site.timezone),
        backfill,
        archive,
        repair,
        rawDeletionPerformed: false,
    };
}

/**
 * Whether an apply run fully migrated the site: backfill ran to the end of
 * what Tesla can fill and every archivable day is archived. Busy or skipped
 * steps don't count, so a --skip-backfill re-run never marks a site migrated.
 */
export function isMigrationComplete(report: SiteMigrationReport): boolean {
    if (report.mode !== 'apply' || report.backfill === 'skipped' || report.archive === 'skipped') return false;
    return ['complete', 'no-progress', 'nothing-to-do'].includes(report.backfill.stopped)
        && ['caught-up', 'nothing-to-do'].includes(report.archive.stopped);
}

const MIGRATION_FLAGS = ['--apply', '--skip-backfill', '--skip-archive', '--repair'];

/** Parse `--site-id <id> [--apply] [--skip-backfill | --skip-archive] [--repair]`. */
export function parseMigrationArgs(args: string[]): { siteId: string; apply: boolean; skipBackfill: boolean; skipArchive: boolean; repair: boolean } {
    const seen = new Set<string>();
    let siteId = '';
    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (seen.has(key)) throw new Error('Duplicate argument');
        seen.add(key);
        if (MIGRATION_FLAGS.includes(key)) continue;
        if (key !== '--site-id' || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or missing argument');
        siteId = args[++i].trim();
    }
    if (!siteId || siteId.length > 200) throw new Error('Explicit site ID required');
    const skipBackfill = seen.has('--skip-backfill');
    const skipArchive = seen.has('--skip-archive');
    if (skipBackfill && skipArchive) throw new Error('Nothing to do with both steps skipped');
    const repair = seen.has('--repair');
    // Repair picks its days from the archive step's report.
    if (repair && skipArchive) throw new Error('--repair needs the archive step');
    return { siteId, apply: seen.has('--apply'), skipBackfill, skipArchive, repair };
}
