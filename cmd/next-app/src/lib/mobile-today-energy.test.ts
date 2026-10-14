import { describe, expect, it, vi } from 'vitest';
import { mobileTodayEnergy } from './mobile-today-energy';

describe('mobileTodayEnergy', () => {
    it('keeps gross imports and exports and uses independently priced daily usage', async () => {
        const now = new Date('2026-10-14T20:00:00Z');
        const sample = new Date('2026-10-14T19:55:00Z');
        const repo = {
            getRawEnergyData: vi.fn().mockResolvedValue([
                { timestamp: sample, load_power: 1000, solar_power: 0, grid_power: 700, battery_power: 0 },
                { timestamp: sample, load_power: 500, solar_power: 1000, grid_power: -300, battery_power: 0 },
            ]),
            getUsageByTOU: vi.fn().mockResolvedValue([{ cost: -0.04, buyRate: 0.2, sellRate: 0.04 }, { cost: 0.2, buyRate: 0.2, sellRate: 0.04 }]),
        };
        const result = await mobileTodayEnergy(repo, 'home', 'America/Chicago', 'USD', now);
        expect(result).toMatchObject({ localDate: '2026-10-14', homeKwh: 1.5, importKwh: 0.7, exportKwh: 0.3, estimatedCost: 0.16, currency: 'USD', energyDataThrough: sample.toISOString() });
        expect(repo.getUsageByTOU).toHaveBeenCalledWith('home', new Date('2026-10-14T05:00:00Z'), now);
    });
    it('does not turn missing observations or missing pricing into zero cost', async () => {
        const repo = { getRawEnergyData: vi.fn().mockResolvedValue([]), getUsageByTOU: vi.fn().mockResolvedValue([]) };
        expect(await mobileTodayEnergy(repo, 'home', 'UTC', 'EUR', new Date())).toMatchObject({ estimatedCost: null, energyDataThrough: null });
    });
    it('shows unknown cost when tariff rates are missing even if pricing returns zero', async () => {
        const now = new Date('2026-10-14T20:00:00Z');
        const repo = {
            getRawEnergyData: vi.fn().mockResolvedValue([{ timestamp: now, load_power: 1000, solar_power: 0, grid_power: 500, battery_power: 0 }]),
            getUsageByTOU: vi.fn().mockResolvedValue([{ cost: 0 }]),
        };
        expect((await mobileTodayEnergy(repo, 'home', 'UTC', 'USD', now)).estimatedCost).toBeNull();
    });
});
