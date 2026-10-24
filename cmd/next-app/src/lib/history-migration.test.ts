import { describe, expect, it, vi } from 'vitest';
import { addDaysInSiteTimezone, formatSiteDate, parseSiteLocalDateToMidnight } from './date-utils';
import { archiveSiteHistory, backfillSiteHistory, isMigrationComplete, repairSiteDays, localDayChunks, migrateSiteHistory, parseMigrationArgs, type ArchiveSummary, type BackfillDeps, type BackfillSummary, type MigrationSite, type SiteMigrationReport } from './history-migration';
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

    it('lists repairable days: stored samples that are short, gappy or not fully attributed, never empty days', async () => {
        const maintain = fakeMaintain(report([
            day('2025-01-01', 'finalized', { needsRepair: true, samples: 280 }),
            day('2025-01-02', 'finalized', { attributionComplete: false }),
            day('2025-01-03', 'empty', { needsRepair: true, samples: 0, attributionComplete: null }),
            day('2025-01-04', 'finalized'),
        ]));
        const summary = await archiveSiteHistory(store, args('2025-01-01', '2025-01-05', true), maintain);
        expect(summary.repairable).toEqual(['2025-01-01', '2025-01-02']);
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
const windows = (...dates: string[]): DateWindow[] => dates.map(d => ({ start: la(d), end: addDaysInSiteTimezone(la(d), 1, LA) }));
const ensured = (processedWindows: number, totalWindows: number, complete = false): EnsureDataResult => ({ complete, rows: [], processedWindows, totalWindows });

function fakeBackfill(plans: DateWindow[][], results: EnsureDataResult[] = []) {
    const plan = vi.fn<BackfillDeps['plan']>();
    for (const p of plans) plan.mockResolvedValueOnce(p);
    plan.mockResolvedValue(plans.at(-1) ?? []);
    const ensure = vi.fn<BackfillDeps['ensure']>();
    for (const r of results) ensure.mockResolvedValueOnce(r);
    const pause = vi.fn<BackfillDeps['pause']>().mockResolvedValue(undefined);
    const recordBackfillFrom = vi.fn<BackfillDeps['recordBackfillFrom']>().mockResolvedValue(undefined);
    const refetch = vi.fn<BackfillDeps['refetch']>();
    return { plan, ensure, pause, recordBackfillFrom, refetch };
}

describe('backfillSiteHistory', () => {
    const end = la('2025-03-01');

    it('preview plans once and never calls ensure', async () => {
        const deps = fakeBackfill([windows('2025-01-05', '2025-01-06')]);
        const summary = await backfillSiteHistory(deps, site, end, false);
        expect(deps.plan).toHaveBeenCalledTimes(1);
        expect(deps.ensure).not.toHaveBeenCalled();
        expect(summary).toEqual({ passes: 0, windowsImported: 0, missingDays: ['2025-01-05', '2025-01-06'], stopped: 'preview', backfillFrom: null });
    });

    it('apply loops ensure with {maxTimeMs:45000, maxWindows:30} until complete', async () => {
        const many = (n: number) => Array.from({ length: n }, (_, i) => ({ start: new Date(+installMidnight + i * 86400000), end: end }));
        const deps = fakeBackfill([many(45), many(15), []], [ensured(30, 45), ensured(15, 15, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).toHaveBeenCalledTimes(2);
        expect(deps.ensure).toHaveBeenCalledWith('site-1', installMidnight, end, { maxTimeMs: 45000, maxWindows: 30 });
        expect(summary).toEqual({ passes: 2, windowsImported: 45, missingDays: [], stopped: 'complete', backfillFrom: null });
    });

    it('no-progress when the planned set stops shrinking', async () => {
        const deps = fakeBackfill([windows('2025-01-05', '2025-01-06')], [ensured(2, 2), ensured(2, 2)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).toHaveBeenCalledTimes(1);
        expect(summary).toMatchObject({ passes: 1, stopped: 'no-progress', missingDays: ['2025-01-05', '2025-01-06'] });
    });

    it('busy after 3 consecutive passes where ensure returns 0/0 while plan still has windows', async () => {
        const deps = fakeBackfill([windows('2025-01-05')], [ensured(0, 0), ensured(0, 0), ensured(0, 0), ensured(1, 1, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).toHaveBeenCalledTimes(3);
        expect(summary).toMatchObject({ passes: 3, stopped: 'busy', missingDays: ['2025-01-05'] });
    });

    it('retries a busy pass after a pause', async () => {
        const deps = fakeBackfill([windows('2025-01-05'), []], [ensured(0, 0), ensured(1, 1, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.pause).toHaveBeenCalledTimes(1);
        expect(summary).toMatchObject({ passes: 2, windowsImported: 1, stopped: 'complete' });
    });

    it('pauses between passes so the app can take the import lock, but not after the last', async () => {
        const order: string[] = [];
        const deps = fakeBackfill([windows('2025-01-04', '2025-01-05', '2025-01-06'), windows('2025-01-05', '2025-01-06'), windows('2025-01-06'), []]);
        deps.ensure.mockImplementation(async () => { order.push('ensure'); return ensured(1, 3); });
        deps.pause.mockImplementation(async () => { order.push('pause'); });
        await backfillSiteHistory(deps, site, end, true);
        expect(order).toEqual(['ensure', 'pause', 'ensure', 'pause', 'ensure']);
    });

    it('nothing-to-do when installed midnight >= end', async () => {
        const deps = fakeBackfill([]);
        const summary = await backfillSiteHistory(deps, site, installMidnight, true);
        expect(deps.plan).not.toHaveBeenCalled();
        expect(summary).toEqual({ passes: 0, windowsImported: 0, missingDays: [], stopped: 'nothing-to-do', backfillFrom: null });
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
        // Days were still shrinking: fetchable history may remain, so this is not a clean stop.
        expect(summary).toMatchObject({ passes: 2, stopped: 'incomplete', missingDays: ['2025-01-06'] });
    });

    it('is incomplete, not no-progress, when the stuck pass had failed or unattempted windows', async () => {
        const deps = fakeBackfill([windows('2025-01-05', '2025-01-06'), windows('2025-01-05', '2025-01-06')], [ensured(1, 2)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(summary).toMatchObject({ passes: 1, stopped: 'incomplete', missingDays: ['2025-01-05', '2025-01-06'] });
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

describe('backfillSiteHistory stalled newest batch', () => {
    const end = la('2025-03-01');
    const day = (i: number) => ({ start: addDaysInSiteTimezone(installMidnight, i, LA), end: addDaysInSiteTimezone(installMidnight, i + 1, LA) });
    const days = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => day(from + i));

    it('sets aside a stuck newest batch and backfills older days', async () => {
        // Days 0-1 are fillable; the newest 30 (days 2-31) never fill.
        const deps = fakeBackfill([days(0, 32), days(0, 32), []], [ensured(30, 32), ensured(2, 2, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).toHaveBeenCalledTimes(2);
        expect(deps.ensure.mock.calls[1].slice(0, 3)).toEqual(['site-1', installMidnight, day(2).start]);
        expect(deps.plan.mock.calls[2]).toEqual([site, installMidnight, day(2).start]);
        expect(summary.stopped).toBe('no-progress');
        expect(summary.windowsImported).toBe(32);
        expect(summary.missingDays).toEqual(days(2, 32).map(w => formatSiteDate(w.start, LA)));
    });

    it('is incomplete when a set-aside batch had failed or unattempted windows', async () => {
        const deps = fakeBackfill([days(0, 32), days(0, 32), []], [ensured(29, 32), ensured(2, 2, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).toHaveBeenCalledTimes(2);
        expect(summary.stopped).toBe('incomplete');
        expect(summary.missingDays).toHaveLength(30);
    });

    it('does not set aside a stuck batch when one pass attempts every planned window', async () => {
        const deps = fakeBackfill([days(5, 10), days(5, 10)], [ensured(5, 5, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.ensure).toHaveBeenCalledTimes(1);
        expect(summary).toMatchObject({ stopped: 'no-progress', missingDays: days(5, 10).map(w => formatSiteDate(w.start, LA)) });
    });

    it('does not record a gap when every planned day is stuck', async () => {
        const deps = fakeBackfill([days(0, 31), days(0, 31), [day(0)]], [ensured(30, 31), ensured(1, 1, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.recordBackfillFrom).not.toHaveBeenCalled();
        expect(summary).toMatchObject({ stopped: 'no-progress', backfillFrom: null });
        expect(summary.missingDays).toHaveLength(31);
    });

    it('can still record the pre-provisioning gap after setting a batch aside', async () => {
        // Days 0-1 are the gap, day 2 has data, days 3-32 never fill.
        const stuckOld = [day(0), day(1)];
        const deps = fakeBackfill([[...stuckOld, ...days(3, 33)], [...stuckOld, ...days(3, 33)], stuckOld, stuckOld], [ensured(30, 32), ensured(2, 2, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.recordBackfillFrom).toHaveBeenCalledWith('site-1', day(2).start);
        expect(summary.backfillFrom).toBe(formatSiteDate(day(2).start, LA));
        expect(summary.missingDays).toHaveLength(32);
    });
});

describe('backfillSiteHistory pre-provisioning gap', () => {
    // Tesla's installation date is the hardware install; data only starts once
    // the utility provisions the site, so the first days after install never fill.
    const end = la('2025-03-01');

    it('records the leading gap after a pass where every attempted window imported but nothing filled', async () => {
        const gap = windows('2025-01-01', '2025-01-02', '2025-01-03');
        const deps = fakeBackfill([gap, gap], [ensured(3, 3, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.recordBackfillFrom).toHaveBeenCalledWith('site-1', la('2025-01-04'));
        expect(summary).toMatchObject({ stopped: 'no-progress', backfillFrom: '2025-01-04', missingDays: ['2025-01-01', '2025-01-02', '2025-01-03'] });
    });

    it('records only the leading run, not later unfillable days', async () => {
        const stuck = windows('2025-01-01', '2025-01-02', '2025-01-10');
        const deps = fakeBackfill([stuck, stuck], [ensured(3, 3, true)]);
        const summary = await backfillSiteHistory(deps, site, end, true);
        expect(deps.recordBackfillFrom).toHaveBeenCalledWith('site-1', la('2025-01-03'));
        expect(summary.backfillFrom).toBe('2025-01-03');
    });

    it.each([
        ['a window failed in the stuck pass', windows('2025-01-01', '2025-01-02'), ensured(1, 2), 'incomplete'],
        ['the stuck days do not start at the backfill start', windows('2025-01-05', '2025-01-06'), ensured(2, 2, true), 'no-progress'],
        ['the gap runs all the way to the end (no data at all)', windows('2025-02-27', '2025-02-28'), ensured(2, 2, true), 'no-progress'],
    ])('does not record when %s', async (_, stuck, result, stopped) => {
        const deps = fakeBackfill([stuck, stuck], [result]);
        const siteForCase = _ === 'the gap runs all the way to the end (no data at all)' ? { ...site, installed: la('2025-02-27') } : site;
        const summary = await backfillSiteHistory(deps, siteForCase, end, true);
        expect(summary.stopped).toBe(stopped);
        expect(deps.recordBackfillFrom).not.toHaveBeenCalled();
        expect(summary.backfillFrom).toBeNull();
    });

    it('starts planning and importing at a recorded backfillFrom', async () => {
        const deps = fakeBackfill([[]]);
        const summary = await backfillSiteHistory(deps, { ...site, backfillFrom: la('2025-01-15') }, end, true);
        expect(deps.plan).toHaveBeenCalledWith(expect.anything(), la('2025-01-15'), end);
        expect(summary.stopped).toBe('complete');
        expect(deps.recordBackfillFrom).not.toHaveBeenCalled();
    });

    it('ignores a backfillFrom before install midnight', async () => {
        const deps = fakeBackfill([[]]);
        await backfillSiteHistory(deps, { ...site, backfillFrom: la('2024-12-01') }, end, true);
        expect(deps.plan).toHaveBeenCalledWith(expect.anything(), installMidnight, end);
    });

    it('never records in preview', async () => {
        const deps = fakeBackfill([windows('2025-01-01')]);
        await backfillSiteHistory(deps, site, end, false);
        expect(deps.recordBackfillFrom).not.toHaveBeenCalled();
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
        const report = await migrateSiteHistory({ site, backfill: fakeBackfill([windows('2025-01-05')], [ensured(0, 0), ensured(0, 0), ensured(0, 0)]), store }, { apply: true, now: migrateNow });
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

describe('parseMigrationArgs', () => {
    it('defaults to preview with both steps', () => {
        expect(parseMigrationArgs(['--site-id', 'abc'])).toEqual({ siteId: 'abc', apply: false, skipBackfill: false, skipArchive: false, repair: false });
    });

    it('accepts --apply, --skip-backfill and --skip-archive', () => {
        expect(parseMigrationArgs(['--apply', '--site-id', 'abc', '--skip-backfill'])).toEqual({ siteId: 'abc', apply: true, skipBackfill: true, skipArchive: false, repair: false });
        expect(parseMigrationArgs(['--site-id', 'abc', '--apply', '--repair'])).toMatchObject({ apply: true, repair: true });
        expect(parseMigrationArgs(['--site-id', 'abc', '--skip-archive'])).toMatchObject({ skipArchive: true, skipBackfill: false });
    });

    it('accepts --repair-from <date>, which implies --repair', () => {
        expect(parseMigrationArgs(['--site-id', 'abc', '--repair-from', '2026-09-09'])).toEqual({ siteId: 'abc', apply: false, skipBackfill: false, skipArchive: false, repair: true, repairFrom: '2026-09-09' });
        expect(parseMigrationArgs(['--site-id', 'abc', '--repair', '--repair-from', '2026-09-09', '--apply'])).toMatchObject({ apply: true, repair: true, repairFrom: '2026-09-09' });
    });

    it.each([
        [[]],
        [['--site-id']],
        [['--site-id', '']],
        [['--site-id', '  ']],
        [['--site-id', '--apply']],
        [['--site-id', 'abc', '--rebuild']],
        [['--site-id', 'abc', 'extra']],
        [['--site-id', 'abc', '--site-id', 'def']],
        [['--site-id', 'abc', '--apply', '--apply']],
        [['--site-id', 'abc', '--skip-backfill', '--skip-archive']],
        [['--site-id', 'abc', '--repair', '--skip-archive']],
        [['--site-id', 'abc', '--repair', '--repair']],
        [['--site-id', 'abc', '--repair-from']],
        [['--site-id', 'abc', '--repair-from', '--apply']],
        [['--site-id', 'abc', '--repair-from', '2026-9-9']],
        [['--site-id', 'abc', '--repair-from', '2026-02-30']],
        [['--site-id', 'abc', '--repair-from', '2026-09-09', '--repair-from', '2026-09-10']],
        [['--site-id', 'abc', '--repair-from', '2026-09-09', '--skip-archive']],
    ])('rejects %j', (args) => {
        expect(() => parseMigrationArgs(args)).toThrow(Error);
    });
});

describe('isMigrationComplete', () => {
    const backfill = (stopped: BackfillSummary['stopped']): BackfillSummary => ({ passes: 1, windowsImported: 0, missingDays: [], stopped, backfillFrom: null });
    const archive = (stopped: ArchiveSummary['stopped']): ArchiveSummary => ({ chunks: 1, archived: [], alreadyArchived: 0, empty: 0, needsRepair: [], incompleteAttribution: [], repairable: [], remaining: [], stopped });
    const report = (b: SiteMigrationReport['backfill'], a: SiteMigrationReport['archive'], mode: SiteMigrationReport['mode'] = 'apply'): SiteMigrationReport =>
        ({ mode, installed: '2023-11-14', cutoff: '2026-10-17', backfill: b, archive: a, repair: 'skipped', rawDeletionPerformed: false });

    it.each([
        ['backfill complete', backfill('complete')],
        ['backfill stopped on days Tesla cannot fill', backfill('no-progress')],
        ['nothing to backfill', backfill('nothing-to-do')],
    ])('is complete when archive caught up and %s', (_, b) => {
        expect(isMigrationComplete(report(b, archive('caught-up')))).toBe(true);
    });

    it.each([
        ['a preview', report(backfill('preview'), archive('preview'), 'preview')],
        ['backfill was busy', report(backfill('busy'), archive('caught-up'))],
        ['backfill stopped with fetchable days left', report(backfill('incomplete'), archive('caught-up'))],
        ['backfill was skipped', report('skipped', archive('caught-up'))],
        ['archive was busy', report(backfill('complete'), archive('busy'))],
        ['archive was skipped', report(backfill('complete'), 'skipped')],
    ])('is not complete for %s', (_, r) => {
        expect(isMigrationComplete(r)).toBe(false);
    });
});

describe('repairSiteDays', () => {
    const dates = (n: number) => Array.from({ length: n }, (_, i) => formatSiteDate(addDaysInSiteTimezone(la('2025-02-01'), i, LA), LA));

    it('previews the planned days without refetching', async () => {
        const deps = fakeBackfill([]);
        const summary = await repairSiteDays(deps, site, ['2025-02-01', '2025-02-03'], false);
        expect(deps.refetch).not.toHaveBeenCalled();
        expect(summary).toEqual({ planned: ['2025-02-01', '2025-02-03'], refetched: 0, stopped: 'preview', stillNeedsRepair: [] });
    });

    it('nothing-to-do with no days', async () => {
        const summary = await repairSiteDays(fakeBackfill([]), site, [], true);
        expect(summary.stopped).toBe('nothing-to-do');
    });

    it('refetches site-local day windows in batches of 30, pausing between batches', async () => {
        const order: string[] = [];
        const deps = fakeBackfill([]);
        deps.refetch.mockImplementation(async (_id, days) => { order.push(`refetch:${days.length}`); return ensured(days.length, days.length, true); });
        deps.pause.mockImplementation(async () => { order.push('pause'); });
        const planned = dates(31);
        const summary = await repairSiteDays(deps, site, planned, true);
        expect(order).toEqual(['refetch:30', 'pause', 'refetch:1']);
        expect(deps.refetch.mock.calls[0][1][0]).toEqual({ start: la('2025-02-01'), end: la('2025-02-02') });
        expect(deps.refetch.mock.calls[0][2]).toEqual({ maxTimeMs: 45000, maxWindows: 30 });
        expect(summary).toMatchObject({ refetched: 31, stopped: 'complete' });
    });

    it('retries a busy batch after a pause, then stops busy after 3', async () => {
        const deps = fakeBackfill([]);
        deps.refetch.mockResolvedValueOnce(ensured(0, 0)).mockResolvedValueOnce(ensured(2, 2, true));
        expect(await repairSiteDays(deps, site, dates(2), true)).toMatchObject({ refetched: 2, stopped: 'complete' });
        expect(deps.pause).toHaveBeenCalledTimes(1);

        const busy = fakeBackfill([]);
        busy.refetch.mockResolvedValue(ensured(0, 0));
        expect(await repairSiteDays(busy, site, dates(2), true)).toMatchObject({ refetched: 0, stopped: 'busy' });
        expect(busy.refetch).toHaveBeenCalledTimes(3);
    });

    it('is incomplete when a batch had failed days, but keeps going', async () => {
        const deps = fakeBackfill([]);
        deps.refetch.mockResolvedValueOnce(ensured(29, 30)).mockResolvedValueOnce(ensured(1, 1, true));
        const summary = await repairSiteDays(deps, site, dates(31), true);
        expect(deps.refetch).toHaveBeenCalledTimes(2);
        expect(summary).toMatchObject({ refetched: 30, stopped: 'incomplete' });
    });
});

describe('migrateSiteHistory --repair', () => {
    const migrateNow = new Date('2025-03-20T19:00:00Z');
    const full = 288;

    /** Store whose coverage comes from per-day sample counts; finalize always succeeds. */
    function countingStore(counts: Map<string, number>): MaintenanceStore {
        return {
            getMaintenanceSnapshot: vi.fn(async (_siteId: string, from: string, before: string) => {
                const coverage = [...counts].filter(([d]) => d >= from && d < before).map(([d, n]) => {
                    const first = la(d);
                    return { localDayKey: d, count: n, first, last: new Date(+first + (full - 1) * 300000), maxInteriorGapMs: n === full ? 300000 : 0 };
                });
                return { timezone: LA, start: la(from), end: la(before), coverage, archives: [] };
            }),
            finalizeDay: vi.fn(async () => ({ status: 'finalized' as const, attributionComplete: true })),
        };
    }

    it('refetches short days on or after the backfill start, skips unfillable and gap days, then re-archives', async () => {
        // 01-01..01-02: pre-provisioning gap (backfillFrom 01-03); 02-10 unfillable (still planned by backfill).
        const counts = new Map([['2025-01-01', 5], ['2025-01-03', full], ['2025-02-05', 280], ['2025-02-10', 100], ['2025-03-01', 287]]);
        const gapSite = { ...site, backfillFrom: la('2025-01-03') };
        const backfill = fakeBackfill([windows('2025-02-10'), windows('2025-02-10')], [ensured(1, 1, true)]);
        backfill.refetch.mockImplementation(async (_id, days) => {
            for (const d of days) counts.set(formatSiteDate(d.start, LA), full);
            return ensured(days.length, days.length, true);
        });
        const report = await migrateSiteHistory({ site: gapSite, backfill, store: countingStore(counts) }, { apply: true, now: migrateNow, repair: true });

        expect(backfill.refetch.mock.calls[0][1]).toEqual(windows('2025-02-05', '2025-03-01'));
        expect(report.repair).toEqual({ planned: ['2025-02-05', '2025-03-01'], refetched: 2, stopped: 'complete', stillNeedsRepair: [] });
        expect(report.archive).toMatchObject({ stopped: 'caught-up' });
        if (report.archive === 'skipped') throw new Error('archive skipped');
        expect(report.archive.repairable).toEqual(['2025-01-01', '2025-02-10']);
    });

    it('reports days Tesla still could not complete', async () => {
        const counts = new Map([['2025-02-05', 280]]);
        const backfill = fakeBackfill([[]]);
        backfill.refetch.mockResolvedValue(ensured(1, 1, true));
        const report = await migrateSiteHistory({ site, backfill, store: countingStore(counts) }, { apply: true, now: migrateNow, repair: true });
        expect(report.repair).toMatchObject({ refetched: 1, stillNeedsRepair: ['2025-02-05'] });
    });

    it('keeps every planned day unresolved when the import lock stays busy', async () => {
        const counts = new Map([['2025-02-05', 280], ['2025-03-01', 287]]);
        const backfill = fakeBackfill([[]]);
        backfill.refetch.mockResolvedValue(ensured(0, 0, false));
        const report = await migrateSiteHistory({ site, backfill, store: countingStore(counts) }, { apply: true, now: migrateNow, repair: true });
        expect(report.repair).toMatchObject({ refetched: 0, stopped: 'busy', stillNeedsRepair: ['2025-02-05', '2025-03-01'] });
    });

    it('keeps days the rebuild never reached unresolved when it stops busy', async () => {
        // Chunks from 2025-01-01: 02-05 is in the second, 03-10 in the third.
        const counts = new Map([['2025-02-05', 280], ['2025-03-10', 287]]);
        const backfill = fakeBackfill([[]]);
        let refetched = false;
        backfill.refetch.mockImplementation(async (_id, days) => {
            for (const d of days) counts.set(formatSiteDate(d.start, LA), full);
            refetched = true;
            return ensured(days.length, days.length, true);
        });
        const store = countingStore(counts);
        vi.mocked(store.finalizeDay).mockImplementation(async (_siteId, start) =>
            refetched && formatSiteDate(start, LA) === '2025-03-10'
                ? { status: 'busy' as const }
                : { status: 'finalized' as const, attributionComplete: true });
        const report = await migrateSiteHistory({ site, backfill, store }, { apply: true, now: migrateNow, repair: true });
        expect(report.archive).toMatchObject({ stopped: 'busy' });
        expect(report.repair).toMatchObject({ refetched: 2, stillNeedsRepair: ['2025-03-10'] });
    });

    it('only plans days on or after repairFrom', async () => {
        const counts = new Map([['2025-02-05', 280], ['2025-03-01', 287], ['2025-03-10', 100]]);
        const backfill = fakeBackfill([[]]);
        const report = await migrateSiteHistory({ site, backfill, store: countingStore(counts) }, { apply: false, now: migrateNow, repair: true, repairFrom: '2025-03-01' });
        expect(report.repair).toMatchObject({ planned: ['2025-03-01', '2025-03-10'], stopped: 'preview' });
    });

    it('previews the days it would refetch', async () => {
        const counts = new Map([['2025-02-05', 280]]);
        const backfill = fakeBackfill([[]]);
        const report = await migrateSiteHistory({ site, backfill, store: countingStore(counts) }, { apply: false, now: migrateNow, repair: true });
        expect(backfill.refetch).not.toHaveBeenCalled();
        expect(report.repair).toMatchObject({ planned: ['2025-02-05'], stopped: 'preview' });
    });

    it('is skipped unless requested', async () => {
        const report = await migrateSiteHistory({ site, backfill: fakeBackfill([[]]), store: countingStore(new Map()) }, { apply: true, now: migrateNow });
        expect(report.repair).toBe('skipped');
    });
});
