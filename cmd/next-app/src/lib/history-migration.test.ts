import { describe, expect, it, vi } from 'vitest';
import { parseSiteLocalDateToMidnight } from './date-utils';
import { archiveSiteHistory, localDayChunks } from './history-migration';
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
