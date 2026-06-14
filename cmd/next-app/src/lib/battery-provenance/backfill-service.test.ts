import { describe, it, expect, vi } from 'vitest';
import { BackfillService, type BackfillDeps, type BackfillJob } from './backfill-service';
import type { EnergyData } from '../db';

const job = (over: Partial<BackfillJob> = {}): BackfillJob => ({
  siteId: 'S1', oldestDate: '2021-06-01', cursorDate: '2021-06-01',
  newestDate: '2021-06-05', daysDone: 0, genesisAnchored: false, ...over,
});

function makeDeps(over: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    loadSite: async () => ({ id: 'S1', timezone: 'UTC', installed: '2021-06-01' }) as never,
    fetchRange: vi.fn(async () => [] as EnergyData[]),
    ensureData: vi.fn(async () => {}),
    rollupDay: vi.fn(async () => ({ genesisAnchored: false })),
    recordProgress: vi.fn(async () => {}),
    markComplete: vi.fn(async () => {}),
    markError: vi.fn(async () => {}),
    retentionCutoff: () => new Date('2025-06-12T00:00:00Z'),
    localDayBounds: (d: string) => ({ start: new Date(`${d}T00:00:00Z`), end: new Date(`${d}T23:59:59.999Z`) }),
    now: () => 0,
    ...over,
  };
}

describe('BackfillService.processSite', () => {
  it('pre-retention days use fetchRange, never ensureData', async () => {
    const deps = makeDeps();
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(deps.fetchRange).toHaveBeenCalledTimes(5);
    expect(deps.ensureData).not.toHaveBeenCalled();
  });

  it('within-retention days use ensureData (persist), not fetchRange', async () => {
    const deps = makeDeps({ retentionCutoff: () => new Date('2000-01-01T00:00:00Z') });
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(deps.ensureData).toHaveBeenCalledTimes(5);
    expect(deps.fetchRange).not.toHaveBeenCalled();
  });

  it('stops at the day-per-tick cap and records the advanced cursor', async () => {
    const deps = makeDeps();
    await new BackfillService(deps).processSite(job(), { daysPerTick: 2, budgetMs: 1e9 });
    expect(deps.rollupDay).toHaveBeenCalledTimes(2);
    expect(deps.recordProgress).toHaveBeenLastCalledWith('S1', '2021-06-03', 2, false);
    expect(deps.markComplete).not.toHaveBeenCalled();
  });

  it('stops when the wall-clock budget is exhausted', async () => {
    let t = 0;
    const deps = makeDeps({ now: () => (t += 100) });
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 150 });
    expect((deps.rollupDay as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(5);
  });

  it('marks complete when the cursor passes newest_date', async () => {
    const deps = makeDeps();
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(deps.markComplete).toHaveBeenCalledWith('S1');
  });

  it('flips genesis_anchored once a day anchors, stops forcing after', async () => {
    const rollupDay = vi.fn()
      .mockResolvedValueOnce({ genesisAnchored: false })  // day 1: forced, no anchor
      .mockResolvedValueOnce({ genesisAnchored: true })   // day 2: forced, anchors
      .mockResolvedValue({ genesisAnchored: false });     // day 3+
    const deps = makeDeps({ rollupDay });
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(rollupDay.mock.calls[0][2]).toEqual({ rows: [], forceGenesisAtStart: true });
    expect(rollupDay.mock.calls[1][2]).toEqual({ rows: [], forceGenesisAtStart: true });
    expect(rollupDay.mock.calls[2][2]).toEqual({ rows: [], forceGenesisAtStart: false });
  });

  it('on error marks the row and preserves the cursor', async () => {
    const deps = makeDeps({ rollupDay: vi.fn(async () => { throw new Error('boom'); }) });
    await new BackfillService(deps).processSite(job(), { daysPerTick: 100, budgetMs: 1e9 });
    expect(deps.markError).toHaveBeenCalledWith('S1', 'boom');
    expect(deps.markComplete).not.toHaveBeenCalled();
  });
});
