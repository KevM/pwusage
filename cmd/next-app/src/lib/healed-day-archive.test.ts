import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: {} }));

import { archiveHealedDays, type HealedDayArchiveRepo } from './healed-day-archive';
import type { HealControl } from './history-archive-service';

const NOW = new Date('2026-10-24T12:00:00Z');
const SITE = { id: 'site', timezone: 'UTC' };
// DATA_RETENTION_DAYS=90 puts the trim cutoff at 2026-07-26 UTC midnight; the
// default 2-day archive-after window puts the archive cutoff at 2026-10-22.
const OLD = { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-07-02T00:00:00Z') };
const OLDER = { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-02T00:00:00Z') };
const RECENT = { start: new Date('2026-10-20T00:00:00Z'), end: new Date('2026-10-21T00:00:00Z') };
const YESTERDAY = { start: new Date('2026-10-23T00:00:00Z'), end: new Date('2026-10-24T00:00:00Z') };
const env = (extra: Record<string, string> = {}) =>
    ({ DATA_RETENTION_DAYS: '90', COMPACT_HISTORY_READS_ENABLED: 'true', ...extra }) as unknown as NodeJS.ProcessEnv;

describe('archiveHealedDays', () => {
    let control: HealControl | null;
    let repo: { [K in keyof HealedDayArchiveRepo]: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        control = { paused: false, trim: true, revision: '7', trimSite: true };
        repo = {
            healControl: vi.fn(async () => control),
            finalize: vi.fn(async () => ({ status: 'finalized', revision: 'rev-1', attributionComplete: true })),
            trim: vi.fn(async () => ({ status: 'trimmed', samples: 288 })),
        };
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    const run = (days = [OLD], extra = {}) =>
        archiveHealedDays(SITE, days, NOW, { repo: repo as unknown as HealedDayArchiveRepo, env: env(extra) });

    it('leaves days inside the archive-after window as raw without touching the archive', async () => {
        expect(await run([YESTERDAY])).toEqual([]);
        expect(repo.healControl).not.toHaveBeenCalled();
    });

    it('archives without trimming a healed day past archive-after but inside retention', async () => {
        expect(await run([RECENT])).toEqual([{ start: RECENT.start.toISOString(), status: 'archived' }]);
        expect(repo.finalize).toHaveBeenCalledOnce();
        expect(repo.trim).not.toHaveBeenCalled();
    });

    it('archives without trimming when the site is outside the trim cohort', async () => {
        control = { paused: false, trim: true, revision: '7', trimSite: false };
        expect(await run()).toEqual([{ start: OLD.start.toISOString(), status: 'archived' }]);
        expect(repo.trim).not.toHaveBeenCalled();
    });

    it('finalizes and trims a healed day past retention, as the archive job would', async () => {
        expect(await run()).toEqual([{ start: OLD.start.toISOString(), status: 'trimmed' }]);
        const day = { siteId: 'site', timezone: 'UTC', ...OLD };
        expect(repo.healControl).toHaveBeenCalledWith(day);
        expect(repo.finalize).toHaveBeenCalledWith(day, NOW, control);
        expect(repo.trim).toHaveBeenCalledWith(day, 'rev-1', NOW, control);
    });

    it('only finalizes in archive-only mode or while compact reads are off', async () => {
        control = { paused: false, trim: false, revision: '7', trimSite: false };
        expect(await run()).toEqual([{ start: OLD.start.toISOString(), status: 'archived' }]);
        control = { paused: false, trim: true, revision: '7', trimSite: true };
        expect(await run([OLD], { COMPACT_HISTORY_READS_ENABLED: 'false' }))
            .toEqual([{ start: OLD.start.toISOString(), status: 'archived' }]);
        expect(repo.trim).not.toHaveBeenCalled();
    });

    it('skips sites outside the archive cohort or while the job is paused', async () => {
        control = null;
        expect(await run()).toEqual([{ start: OLD.start.toISOString(), status: 'skipped' }]);
        expect(repo.finalize).not.toHaveBeenCalled();
    });

    it('does not trim a day whose tariff attribution is incomplete', async () => {
        repo.finalize.mockResolvedValueOnce({ status: 'finalized', revision: 'rev-1', attributionComplete: false });
        expect(await run()).toEqual([{ start: OLD.start.toISOString(), status: 'incomplete-attribution' }]);
        expect(repo.trim).not.toHaveBeenCalled();
    });

    it('isolates per-day failures and never throws, leaving the archive job as the backstop', async () => {
        repo.finalize.mockRejectedValueOnce(new Error('Energy mutation claim busy'));
        expect(await run([OLDER, OLD])).toEqual([
            { start: OLDER.start.toISOString(), status: 'failed' },
            { start: OLD.start.toISOString(), status: 'trimmed' },
        ]);
    });

    it('reports a busy finalize or trim claim without retrying', async () => {
        repo.trim.mockResolvedValueOnce({ status: 'busy', samples: 0 });
        expect(await run()).toEqual([{ start: OLD.start.toISOString(), status: 'busy' }]);
    });

    it('defers days left once the caller\'s deadline passes to the archive job', async () => {
        let clock = 0;
        repo.finalize.mockImplementation(async () => {
            clock += 10;
            return { status: 'finalized', revision: 'rev-1', attributionComplete: true };
        });
        const result = await archiveHealedDays(SITE, [OLDER, OLD], NOW,
            { repo: repo as unknown as HealedDayArchiveRepo, env: env(), deadline: 5, clock: () => clock });
        expect(result).toEqual([
            { start: OLDER.start.toISOString(), status: 'trimmed' },
            { start: OLD.start.toISOString(), status: 'deferred' },
        ]);
        expect(repo.finalize).toHaveBeenCalledTimes(1);
    });

    it('does nothing on invalid archive configuration', async () => {
        expect(await run([OLD], { DATA_RETENTION_DAYS: 'soon' })).toEqual([]);
        expect(await run([OLD], { HISTORY_ARCHIVE_AFTER_DAYS: '1' })).toEqual([]);
        expect(repo.healControl).not.toHaveBeenCalled();
    });
});
