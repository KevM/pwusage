import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCycleRollupCache, getCachedCycleRollup } from './cycle-rollup-cache';
import type { UsageData } from './energy-repo';

const CYCLE_START = new Date('2026-08-16T07:00:00Z');
const MIDNIGHT = new Date('2026-08-24T07:00:00Z');
const NEXT_MIDNIGHT = new Date('2026-08-25T07:00:00Z');

const rows: UsageData[] = [];

beforeEach(() => clearCycleRollupCache());

describe('getCachedCycleRollup', () => {
    it('loads once and reuses the result for the same day', async () => {
        const load = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('reloads when the day boundary moves', async () => {
        const load = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load);
        await getCachedCycleRollup('s1', CYCLE_START, NEXT_MIDNIGHT, load);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('caches per site', async () => {
        const load = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load);
        await getCachedCycleRollup('s2', CYCLE_START, MIDNIGHT, load);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not cache a rejected load', async () => {
        const failing = vi.fn().mockRejectedValue(new Error('db down'));
        await expect(getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, failing)).rejects.toThrow('db down');
        const ok = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, ok);
        expect(ok).toHaveBeenCalledTimes(1);
    });

    it('reloads when the version key changes mid-day', async () => {
        const load = vi.fn().mockResolvedValue(rows);
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load, 'v1');
        await getCachedCycleRollup('s1', CYCLE_START, MIDNIGHT, load, 'v2');
        expect(load).toHaveBeenCalledTimes(2);
    });
});
