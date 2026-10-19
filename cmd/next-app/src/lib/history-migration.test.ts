import { describe, expect, it, vi } from 'vitest';
import { parseSiteLocalDateToMidnight } from './date-utils';
import { archiveSiteHistory, backfillSiteHistory, localDayChunks, migrateSiteHistory, type BackfillDeps, type MigrationSite } from './history-migration';
import type { DateWindow } from './importer/import-planner';
import type { EnsureDataResult } from './importer';
import type { MaintenanceDay, MaintenanceOptions, MaintenanceReport, MaintenanceStore } from './prototypes/compact-history-maintenance';

const LA = 'America/Los_Angeles';
const la = (date: string) => parseSiteLocalDateToMidnight(date, LA);

describe('localDayChunks', () => {
    it('splits 70 days into 31+31+8', () => {
        expect(localDayChunks(la('2025-01-01'), la('2025-03-12'), LA)).toEqual([
            { from: '2025-01-01', before: '2025-02-01' },
            { from: '2025-02-01', before: '2025-03-04' },
            { from: '2025-03-04', before: '2025-03-12' },
        ]);
    });

    it('crosses DST fall-back on local midnights', () => {
        const chunks = localDayChunks(la('2025-10-20'), la('2025-11-25'), LA);
        expect(chunks[0]).toEqual({ from: '2025-10-20', before: '2025-11-20' });
        expect(chunks.at(-1)).toEqual({ from: '2025-11-20', before: '2025-11-25' });
    });

    it('returns [] when start >= end', () => {
        expect(localDayChunks(la('2025-03-12'), la('2025-03-12'), LA)).toEqual([]);
        expect(localDayChunks(la('2025-03-13'), la('2025-03-12'), LA)).toEqual([]);
    });
});

const store = {} as MaintenanceStore;
const now = new Date('2025-03-20T12:00:00Z');

function day(date: string, status: MaintenanceDay['status'], extra: Partial<MaintenanceDay> = {}): MaintenanceDay {
    return { date, rawPruned: false, samples: 288, expectedSamples: 288, needsRepair: false, attributionComplete: true, status, ...extra };
}

function report(days: MaintenanceDay[], stopped: MaintenanceReport['stopped'] = null, mode: MaintenanceReport['mode'] = 'apply'): MaintenanceReport {
    return {
        mode, days, stopped,
        remaining: days.filter(d => d.status === 'pending' || d.status === 'busy').map(d => d.date),
        rawDataRetained: true, rawDeletionPerformed: false, teslaRequests: 0,
    };
}

function fakeMaintain(...reports: MaintenanceReport[]) {
    const fn = vi.fn<(s: MaintenanceStore, o: MaintenanceOptions) => Promise<MaintenanceReport>>();
    for (const r of reports) fn.mockResolvedValueOnce(r);
    return fn;
}

const args = (start: string, end: string, apply: boolean) => ({ siteId: 'site-1', start: la(start), end: la(end), timezone: LA, apply, now });

describe('archiveSiteHistory', () => {
    it('preview calls maintain once per chunk with apply:false and reports pending days as remaining', async () => {
        const maintain = fakeMaintain(
            report([day('2025-01-01', 'pending'), day('2025-01-02', 'archived')], null, 'preview'),
            report([day('2025-02-01', 'pending'), day('2025-02-02', 'empty', { samples: 0, needsRepair: true })], null, 'preview'),
        );
        const summary = await archiveSiteHistory(store, args('2025-01-01', '2025-02-03', false), maintain);
        expect(maintain).toHaveBeenCalledTimes(2);
        expect(maintain.mock.calls[0]).toEqual([store, { siteId: 'site-1', from: '2025-01-01', before: '2025-02-01', apply: false, maxDays: 7, maxTimeMs: 45000, now }]);
        expect(maintain.mock.calls[1][1]).toMatchObject({ from: '2025-02-01', before: '2025-02-03', apply: false });
        expect(summary).toMatchObject({ stopped: 'preview', chunks: 2, remaining: ['2025-01-01', '2025-02-01'], archived: [], alreadyArchived: 1, empty: 1 });
    });

    it('apply re-calls a chunk until remaining is empty', async () => {
        const maintain = fakeMaintain(
            report([day('2025-01-01', 'finalized'), day('2025-01-02', 'unchanged'), day('2025-01-03', 'archived'), day('2025-01-04', 'empty', { samples: 0 }), day('2025-01-08', 'pending')], 'day-budget'),
            report([day('2025-01-01', 'archived'), day('2025-01-02', 'archived'), day('2025-01-03', 'archived'), day('2025-01-04', 'empty', { samples: 0 }), day('2025-01-08', 'finalized')]),
        );
        const summary = await archiveSiteHistory(store, args('2025-01-01', '2025-01-09', true), maintain);
        expect(maintain).toHaveBeenCalledTimes(2);
        expect(maintain.mock.calls[1][1]).toMatchObject({ from: '2025-01-01', before: '2025-01-09', apply: true });
        expect(summary).toMatchObject({ stopped: 'caught-up', chunks: 1, remaining: [], empty: 1 });
        expect(summary.archived).toEqual(['2025-01-01', '2025-01-08']);
    });

    it('collects needsRepair and incompleteAttribution dates', async () => {
        const maintain = fakeMaintain(report([
            day('2025-01-01', 'finalized', { needsRepair: true, samples: 280 }),
            day('2025-01-02', 'finalized', { needsRepair: true, attributionComplete: false }),
            day('2025-01-03', 'finalized'),
        ]));
        const summary = await archiveSiteHistory(store, args('2025-01-01', '2025-01-04', true), maintain);
        expect(summary.needsRepair).toEqual(['2025-01-01', '2025-01-02']);
        expect(summary.incompleteAttribution).toEqual(['2025-01-02']);
    });

    it('stops after 3 consecutive busy reports for the same chunk', async () => {
        const busy = () => report([day('2025-01-01', 'busy'), day('2025-01-02', 'pending')], 'busy');
        const maintain = fakeMaintain(busy(), busy(), busy(), report([]));
        const summary = await archiveSiteHistory(store, args('2025-01-01', '2025-03-01', true), maintain);
        expect(maintain).toHaveBeenCalledTimes(3);
        expect(maintain.mock.calls.every(c => c[1].from === '2025-01-01')).toBe(true);
        expect(summary).toMatchObject({ stopped: 'busy', remaining: ['2025-01-01', '2025-01-02'] });
    });

    it('resets the busy count when remaining shrinks', async () => {
        const maintain = fakeMaintain(
            report([day('2025-01-01', 'busy'), day('2025-01-02', 'pending'), day('2025-01-03', 'pending')], 'busy'),
            report([day('2025-01-01', 'busy'), day('2025-01-02', 'pending'), day('2025-01-03', 'pending')], 'busy'),
            report([day('2025-01-01', 'finalized'), day('2025-01-02', 'busy'), day('2025-01-03', 'pending')], 'busy'),
            report([day('2025-01-01', 'archived'), day('2025-01-02', 'busy'), day('2025-01-03', 'pending')], 'busy'),
            report([day('2025-01-01', 'archived'), day('2025-01-02', 'finalized'), day('2025-01-03', 'finalized')]),
        );
        const summary = await archiveSiteHistory(store, args('2025-01-01', '2025-01-04', true), maintain);
        expect(maintain).toHaveBeenCalledTimes(5);
        expect(summary.stopped).toBe('caught-up');
    });

    it('nothing-to-do when start >= end', async () => {
        const maintain = fakeMaintain();
        const summary = await archiveSiteHistory(store, args('2025-01-04', '2025-01-04', true), maintain);
        expect(maintain).not.toHaveBeenCalled();
        expect(summary).toMatchObject({ stopped: 'nothing-to-do', chunks: 0, remaining: [] });
    });

    it('counts each date once, using its latest status, when a chunk is re-called', async () => {
        const maintain = fakeMaintain(
            report([day('2025-01-01', 'finalized'), day('2025-01-02', 'busy')], 'busy'),
            report([day('2025-01-01', 'archived'), day('2025-01-02', 'finalized')]),
        );
        const summary = await archiveSiteHistory(store, args('2025-01-01', '2025-01-03', true), maintain);
        expect(summary.archived).toEqual(['2025-01-01', '2025-01-02']);
        expect(summary.alreadyArchived).toBe(0);
    });
});

const site: MigrationSite = { id: 'site-1', timezone: LA, installed: new Date('2025-01-01T15:30:00Z') };
const installMidnight = la('2025-01-01');
const windows = (...dates: string[]): DateWindow[] => dates.map(d => ({ start: la(d), end: la(d) }));
const ensured = (processedWindows: number, totalWindows: number, complete = false): EnsureDataResult => ({ complete, rows: [], processedWindows, totalWindows });

function fakeBackfill(plans: DateWindow[][], results: EnsureDataResult[] = []) {
    const plan = vi.fn<BackfillDeps['plan']>();
    for (const p of plans) plan.mockResolvedValueOnce(p);
    plan.mockResolvedValue(plans.at(-1) ?? []);
    const ensure = vi.fn<BackfillDeps['ensure']>();
    for (const r of results) ensure.mockResolvedValueOnce(r);
    return { plan, ensure };
}

describe('backfillSiteHistory', () => {
    const end = la('2025-03-01');

    it('preview plans once and never calls ensure', async () => {
        const deps = fakeBackfill([windows('2025-01-05', '2025-01-06')]);
        const summary = await backfillSiteHistory(deps, site, end, false);
        expect(deps.plan).toHaveBeenCalledTimes(1);
        expect(deps.ensure).not.toHaveBeenCalled();
        expect(summary).toEqual({ passes: 0, windowsImported: 0, missingDays: ['2025-01-05', '2025-01-06'], stopped: 'preview' });
    });

    it('apply loops ensure with {maxTimeMs:45000, maxWindows:30} until complete', async () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => ({ start: new Date(+installMidnight + i * 86400000), end: end }));
        const deps = fakeBackfill([many(45), many(15), []], [ensured(30, 45), ensured(15, 15, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).toHaveBeenCalledTimes(2);
        expect(deps.ensure).toHaveBeenCalledWith('site-1', installMidnight, end, { maxTimeMs: 45000, maxWindows: 30 });
        expect(summary).toEqual({ passes: 2, windowsImported: 45, missingDays: [], stopped: 'complete' });
    });

    it('no-progress when the planned set stops shrinking', async () => {
        const deps = fakeBackfill([windows('2025-01-05', '2025-01-06')], [ensured(2, 2), ensured(2, 2)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).toHaveBeenCalledTimes(1);
        expect(summary).toMatchObject({ passes: 1, stopped: 'no-progress', missingDays: ['2025-01-05', '2025-01-06'] });
    });

    it('busy when ensure returns 0/0 while plan still has windows', async () => {
        const deps = fakeBackfill([windows('2025-01-05')], [ensured(0, 0)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(summary).toMatchObject({ passes: 1, stopped: 'busy', missingDays: ['2025-01-05'] });
    });

    it('nothing-to-do when installed midnight >= end', async () => {
        const deps = fakeBackfill([]);
        const summary = await backfillSiteHistory(deps, site, installMidnight, true);
        expect(deps.plan).not.toHaveBeenCalled();
        expect(summary).toEqual({ passes: 0, windowsImported: 0, missingDays: [], stopped: 'nothing-to-do' });
    });

    it('complete without calling ensure when nothing is planned', async () => {
        const deps = fakeBackfill([[]]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).not.toHaveBeenCalled();
        expect(summary.stopped).toBe('complete');
    });

    it('stops at maxPasses', async () => {
        const deps = fakeBackfill([windows('2025-01-04', '2025-01-05', '2025-01-06'), windows('2025-01-05', '2025-01-06'), windows('2025-01-06')], [ensured(1, 3), ensured(1, 2)]);
        const summary = await backfillSiteHistory(deps, site, end, true, 2);
        expect(deps.ensure).toHaveBeenCalledTimes(2);
        expect(summary).toMatchObject({ passes: 2, stopped: 'no-progress', missingDays: ['2025-01-06'] });
    });

    it('plans and ensures [installed site midnight, end)', async () => {
        const deps = fakeBackfill([windows('2025-01-05'), []], [ensured(1, 1, true)]);
        await backfillSiteHistory(deps, site, end, true);
        expect(deps.plan).toHaveBeenCalledWith(site, installMidnight, end);
        expect(deps.ensure.mock.calls[0].slice(0, 3)).toEqual(['site-1', installMidnight, end]);
    });

    it('propagates an ensure failure', async () => {
        const deps = fakeBackfill([windows('2025-01-05')]);
        deps.ensure.mockRejectedValueOnce(new Error('All 1 import windows failed'));
        await expect(backfillSiteHistory(deps, site, end, true)).rejects.toThrow('All 1 import windows failed');
    });
});

describe('migrateSiteHistory', () => {
    // 2025-03-20 local → cutoff is LA midnight 2025-03-18.
    const migrateNow = new Date('2025-03-20T19:00:00Z');
    const cutoff = la('2025-03-18');

    function fakeStore(calls: string[] = []): MaintenanceStore {
        return {
            getMaintenanceSnapshot: vi.fn(async (_siteId: string, from: string, before: string) => {
                calls.push(`archive:${from}..${before}`);
                return { timezone: LA, start: la(from), end: la(before), coverage: [], archives: [] };
            }),
            finalizeDay: vi.fn(),
        };
    }

    it('uses archiveCutoff(now, tz, 2) as the end for both steps', async () => {
        const backfill = fakeBackfill([[]]);
        const store = fakeStore();
        const report = await migrateSiteHistory({ site, backfill, store }, { apply: true, now: migrateNow });
        expect(backfill.plan).toHaveBeenCalledWith(site, installMidnight, cutoff);
        const snapshots = vi.mocked(store.getMaintenanceSnapshot).mock.calls;
        expect(snapshots[0].slice(1, 3)).toEqual(['2025-01-01', '2025-02-01']);
        expect(snapshots.at(-1)?.[2]).toBe('2025-03-18');
        expect(report).toMatchObject({ mode: 'apply', installed: '2025-01-01', cutoff: '2025-03-18', rawDeletionPerformed: false });
    });

    it('runs backfill before archive', async () => {
        const calls: string[] = [];
        const backfill = fakeBackfill([windows('2025-01-05'), []]);
        backfill.ensure.mockImplementation(async () => { calls.push('backfill'); return ensured(1, 1, true); });
        await migrateSiteHistory({ site, backfill, store: fakeStore(calls) }, { apply: true, now: migrateNow });
        expect(calls[0]).toBe('backfill');
        expect(calls.slice(1).every(c => c.startsWith('archive:'))).toBe(true);
    });

    it('skipBackfill / skipArchive yield skipped', async () => {
        const backfill = fakeBackfill([[]]);
        const store = fakeStore();
        const noBackfill = await migrateSiteHistory({ site, backfill, store }, { apply: false, now: migrateNow, skipBackfill: true });
        expect(noBackfill.backfill).toBe('skipped');
        expect(backfill.plan).not.toHaveBeenCalled();
        const noArchive = await migrateSiteHistory({ site, backfill, store: fakeStore() }, { apply: false, now: migrateNow, skipArchive: true });
        expect(noArchive).toMatchObject({ mode: 'preview', archive: 'skipped' });
        expect(noArchive.backfill).toMatchObject({ stopped: 'preview' });
    });

    it('still archives after backfill stops busy or no-progress', async () => {
        const store = fakeStore();
        const report = await migrateSiteHistory({ site, backfill: fakeBackfill([windows('2025-01-05')], [ensured(0, 0)]), store }, { apply: true, now: migrateNow });
        expect(report.backfill).toMatchObject({ stopped: 'busy' });
        expect(store.getMaintenanceSnapshot).toHaveBeenCalled();
        expect(report.archive).toMatchObject({ stopped: 'caught-up' });
    });

    it('does nothing for a site installed within the last 2 days', async () => {
        const recent: MigrationSite = { ...site, installed: new Date('2025-03-19T18:00:00Z') };
        const backfill = fakeBackfill([[]]);
        const store = fakeStore();
        const report = await migrateSiteHistory({ site: recent, backfill, store }, { apply: true, now: migrateNow });
        expect(report.backfill).toMatchObject({ stopped: 'nothing-to-do' });
        expect(report.archive).toMatchObject({ stopped: 'nothing-to-do' });
        expect(store.getMaintenanceSnapshot).not.toHaveBeenCalled();
    });
});
