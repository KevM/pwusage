import { describe, it, expect } from 'vitest';
import { transformEnergyPoints, TransformContext } from './energy-transformer';
import { EnergyHistoryEntry, SoeHistoryEntry } from '../tesla-client';

function makeEntry(overrides: Partial<EnergyHistoryEntry> = {}): EnergyHistoryEntry {
    return {
        timestamp: '2026-01-10T12:00:00.000Z',
        solar_energy_exported: 0,
        generator_energy_exported: 0,
        grid_energy_imported: 0,
        grid_services_energy_imported: 0,
        grid_services_energy_exported: 0,
        grid_energy_exported_from_solar: 0,
        grid_energy_exported_from_generator: 0,
        grid_energy_exported_from_battery: 0,
        battery_energy_exported: 0,
        battery_energy_imported_from_grid: 0,
        battery_energy_imported_from_solar: 0,
        battery_energy_imported_from_generator: 0,
        consumer_energy_imported_from_grid: 0,
        consumer_energy_imported_from_solar: 0,
        consumer_energy_imported_from_battery: 0,
        consumer_energy_imported_from_generator: 0,
        total_home_usage: 0,
        total_solar_generation: 0,
        total_battery_charge: 0,
        total_battery_discharge: 0,
        total_grid_energy_exported: 0,
        ...overrides,
    };
}

const CONTEXT: TransformContext = {
    siteId: 'site-123',
    getTariffId: () => 1,
    getTariffScheduleId: () => null,
};

describe('transformEnergyPoints', () => {
    it('maps total_home_usage to load_power', () => {
        const history = [makeEntry({ total_home_usage: 100 })];
        const [row] = transformEnergyPoints(history, [], CONTEXT);
        expect(row.load_power).toBe(100);
    });

    it('maps total_solar_generation to solar_power', () => {
        const history = [makeEntry({ total_solar_generation: 50 })];
        const [row] = transformEnergyPoints(history, [], CONTEXT);
        expect(row.solar_power).toBe(50);
    });

    it('uses solar_energy_exported when total_solar_generation is undefined', () => {
        const history = [makeEntry({ total_solar_generation: undefined, solar_energy_exported: 30 })];
        const [row] = transformEnergyPoints(history, [], CONTEXT);
        expect(row.solar_power).toBe(30);
    });

    it('uses total_solar_generation even if it is 0', () => {
        const history = [makeEntry({ total_solar_generation: 0, solar_energy_exported: 30 })];
        const [row] = transformEnergyPoints(history, [], CONTEXT);
        expect(row.solar_power).toBe(0);
    });

    it('sets grid_power positive for grid import', () => {
        const history = [makeEntry({ grid_energy_imported: 200 })];
        const [row] = transformEnergyPoints(history, [], CONTEXT);
        expect(row.grid_power).toBe(200);
    });

    it('sets grid_power negative for grid export', () => {
        const history = [makeEntry({ grid_energy_imported: 0, total_grid_energy_exported: 150 })];
        const [row] = transformEnergyPoints(history, [], CONTEXT);
        expect(row.grid_power).toBe(-150);
    });

    it('sets battery_power positive for charge, negative for discharge', () => {
        const charge = [makeEntry({ total_battery_charge: 80, total_battery_discharge: 0 })];
        expect(transformEnergyPoints(charge, [], CONTEXT)[0].battery_power).toBe(80);

        const discharge = [makeEntry({ total_battery_charge: 0, total_battery_discharge: 40 })];
        expect(transformEnergyPoints(discharge, [], CONTEXT)[0].battery_power).toBe(-40);
    });

    it('never scales values — single-day Tesla requests return Wh samples, not kWh aggregates', () => {
        // 2026-07-12 DB audit: the ×1000 "day aggregate" path never matched a
        // real aggregate (single-day requests never return day totals) and
        // produced 85 poisoned rows from lone / day-spaced 5-minute samples
        // (e.g. an install day going live at 23:50). Scaling is removed.
        const lone = [makeEntry({ total_home_usage: 150, timestamp: '2026-01-10T23:50:00.000Z' })];
        expect(transformEnergyPoints(lone, [], CONTEXT)[0].load_power).toBe(150);

        const daySpaced = [
            makeEntry({ total_home_usage: 64, timestamp: '2026-01-10T00:00:00.000Z' }),
            makeEntry({ total_home_usage: 64, timestamp: '2026-01-11T00:00:00.000Z' }),
        ];
        const rows = transformEnergyPoints(daySpaced, [], CONTEXT);
        expect(rows[0].load_power).toBe(64);
        expect(rows[1].load_power).toBe(64);
    });

    it('sets battery_soc from matching SoC sample', () => {
        const ts = '2026-01-10T12:00:00.000Z';
        const history = [makeEntry({ timestamp: ts })];
        const soeHistory: SoeHistoryEntry[] = [{ timestamp: ts, percentage_charged: 75 }];
        const [row] = transformEnergyPoints(history, soeHistory, CONTEXT);
        expect(row.battery_soc).toBe(75);
    });

    it('sets battery_soc to null when no SoC sample within 5 min', () => {
        const history = [makeEntry({ timestamp: '2026-01-10T12:00:00.000Z' })];
        const soeHistory: SoeHistoryEntry[] = [
            { timestamp: '2026-01-10T11:50:00.000Z', percentage_charged: 60 },
        ];
        const [row] = transformEnergyPoints(history, soeHistory, CONTEXT);
        expect(row.battery_soc).toBeNull();
    });

    it('skips entries when getTariffId returns null', () => {
        const ctx: TransformContext = { siteId: 'site-123', getTariffId: () => null, getTariffScheduleId: () => null };
        const history = [makeEntry()];
        expect(transformEnergyPoints(history, [], ctx)).toHaveLength(0);
    });

    it('sets site_id and tariff_id from context', () => {
        const ctx: TransformContext = { siteId: 'my-site', getTariffId: () => 42, getTariffScheduleId: () => null };
        const [row] = transformEnergyPoints([makeEntry()], [], ctx);
        expect(row.site_id).toBe('my-site');
        expect(row.tariff_id).toBe(42);
    });

    it('nets grid_power when an interval has both import and export', () => {
        const history = [makeEntry({ grid_energy_imported: 50, total_grid_energy_exported: 300 })];
        const [row] = transformEnergyPoints(history, [], CONTEXT);
        expect(row.grid_power).toBe(-250); // 50 imported - 300 exported
    });

    it('nets battery_power when an interval has both charge and discharge', () => {
        const history = [makeEntry({ total_battery_charge: 20, total_battery_discharge: 120 })];
        const [row] = transformEnergyPoints(history, [], CONTEXT);
        expect(row.battery_power).toBe(-100); // 20 charged - 120 discharged
    });
});
