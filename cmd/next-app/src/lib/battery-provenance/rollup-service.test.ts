import { describe, it, expect, vi } from 'vitest';
import { RollupService, type RollupDeps } from './rollup-service';
import type { EnergyData } from '../db';
import type { HourlyBucket } from './hourly-profile';

function row(ts: string, fields: Partial<EnergyData>): EnergyData {
    return { timestamp: new Date(ts), site_id: 'S1', tariff_id: 1, tariff_schedule_id: 10,
        load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null,
        battery_charge_from_solar: null, battery_charge_from_grid: null, ...fields };
}

describe('RollupService.rollupDay', () => {
    it('aggregates the day into hourly buckets and upserts them', async () => {
        const persisted: HourlyBucket[] = [];
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs: [] }),
            loadEnergyData: async () => [ row('2026-01-02T13:00:00Z', { load_power: 3000, grid_power: 3000 }) ],
            upsertHourly: async (b) => { persisted.push(...b); },
        };
        const res = await new RollupService(deps).rollupDay('S1', '2026-01-02');
        expect(res.rollupCount).toBeGreaterThan(0);
        expect(res.genesisAnchored).toBe(false);
        expect(persisted.length).toBeGreaterThan(0);
        expect(persisted.every(b => b.localDate === '2026-01-02')).toBe(true);
    });

    it('no-ops when the day has no rows', async () => {
        const upsertHourly = vi.fn();
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs: [] }),
            loadEnergyData: async () => [],
            upsertHourly,
        };
        const res = await new RollupService(deps).rollupDay('S1', '2026-01-02');
        expect(res.rollupCount).toBe(0);
        expect(upsertHourly).not.toHaveBeenCalled();
    });

    it('uses supplied rows and never calls loadEnergyData', async () => {
        const loadEnergyData = vi.fn();
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs: [] }),
            loadEnergyData,
            upsertHourly: async () => {},
        };
        await new RollupService(deps).rollupDay('S1', '2026-01-02', {
            rows: [ row('2026-01-02T12:00:00Z', { load_power: 1000, grid_power: 1000 }) ],
        });
        expect(loadEnergyData).not.toHaveBeenCalled();
    });

    it('filters buckets to the requested local day', async () => {
        const persisted: HourlyBucket[] = [];
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'America/Los_Angeles', tariffs: [] }),
            loadEnergyData: async () => [
                // 2026-01-02T07:00:00Z = 2026-01-01 23:00 LA (previous local day) — filtered out
                row('2026-01-02T07:00:00Z', { load_power: 1000, grid_power: 1000 }),
                // 2026-01-02T20:00:00Z = 2026-01-02 12:00 LA — kept
                row('2026-01-02T20:00:00Z', { load_power: 1000, grid_power: 1000 }),
            ],
            upsertHourly: async (b) => { persisted.push(...b); },
        };
        await new RollupService(deps).rollupDay('S1', '2026-01-02');
        expect(persisted.length).toBe(1);
        expect(persisted.every(b => b.localDate === '2026-01-02')).toBe(true);
    });

    it('accepts forceGenesisAtStart for backfill compatibility (no-op, anchored stays false)', async () => {
        const deps: RollupDeps = {
            loadSite: async () => ({ id: 'S1', timezone: 'UTC', tariffs: [] }),
            loadEnergyData: async () => [ row('2026-01-02T12:00:00Z', { load_power: 1000, grid_power: 1000 }) ],
            upsertHourly: async () => {},
        };
        const res = await new RollupService(deps).rollupDay('S1', '2026-01-02', { forceGenesisAtStart: true });
        expect(res.genesisAnchored).toBe(false);
    });
});
