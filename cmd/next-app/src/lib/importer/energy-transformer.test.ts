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
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.load_power).toBe(100);
    });

    it('maps total_solar_generation to solar_power', () => {
        const history = [makeEntry({ total_solar_generation: 50 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.solar_power).toBe(50);
    });

    it('uses solar_energy_exported when total_solar_generation is undefined', () => {
        const history = [makeEntry({ total_solar_generation: undefined, solar_energy_exported: 30 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.solar_power).toBe(30);
    });

    it('uses total_solar_generation even if it is 0', () => {
        const history = [makeEntry({ total_solar_generation: 0, solar_energy_exported: 30 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.solar_power).toBe(0);
    });

    it('sets grid_power positive for grid import', () => {
        const history = [makeEntry({ grid_energy_imported: 200 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.grid_power).toBe(200);
    });

    it('sets grid_power negative for grid export', () => {
        const history = [makeEntry({ grid_energy_imported: 0, total_grid_energy_exported: 150 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.grid_power).toBe(-150);
    });

    it('sets battery_power positive for charge, negative for discharge', () => {
        const charge = [makeEntry({ total_battery_charge: 80, total_battery_discharge: 0 })];
        expect(transformEnergyPoints(charge, [], 'day', 1, CONTEXT)[0].battery_power).toBe(80);

        const discharge = [makeEntry({ total_battery_charge: 0, total_battery_discharge: 40 })];
        expect(transformEnergyPoints(discharge, [], 'day', 1, CONTEXT)[0].battery_power).toBe(-40);
    });

    it('scales load_power by 1000 for full-day aggregates (period=day, duration>20h)', () => {
        const history = [
            makeEntry({ total_home_usage: 64, timestamp: '2026-01-10T00:00:00.000Z' }),
            makeEntry({ total_home_usage: 64, timestamp: '2026-01-11T00:00:00.000Z' }),
        ];
        const rows = transformEnergyPoints(history, [], 'day', 24, CONTEXT);
        expect(rows[0].load_power).toBe(64 * 1000);
    });

    it('does NOT scale for partial-day singleton (period=day, requestedDurationHours<=20)', () => {
        const history = [makeEntry({ total_home_usage: 64 })];
        const [row] = transformEnergyPoints(history, [], 'day', 7, CONTEXT);
        expect(row.load_power).toBe(64);
    });

    it('sets battery_soc from matching SoC sample', () => {
        const ts = '2026-01-10T12:00:00.000Z';
        const history = [makeEntry({ timestamp: ts })];
        const soeHistory: SoeHistoryEntry[] = [{ timestamp: ts, percentage_charged: 75 }];
        const [row] = transformEnergyPoints(history, soeHistory, 'day', 1, CONTEXT);
        expect(row.battery_soc).toBe(75);
    });

    it('sets battery_soc to null when no SoC sample within 5 min', () => {
        const history = [makeEntry({ timestamp: '2026-01-10T12:00:00.000Z' })];
        const soeHistory: SoeHistoryEntry[] = [
            { timestamp: '2026-01-10T11:50:00.000Z', percentage_charged: 60 },
        ];
        const [row] = transformEnergyPoints(history, soeHistory, 'day', 1, CONTEXT);
        expect(row.battery_soc).toBeNull();
    });

    it('skips entries when getTariffId returns null', () => {
        const ctx: TransformContext = { siteId: 'site-123', getTariffId: () => null, getTariffScheduleId: () => null };
        const history = [makeEntry()];
        expect(transformEnergyPoints(history, [], 'day', 1, ctx)).toHaveLength(0);
    });

    it('sets site_id and tariff_id from context', () => {
        const ctx: TransformContext = { siteId: 'my-site', getTariffId: () => 42, getTariffScheduleId: () => null };
        const [row] = transformEnergyPoints([makeEntry()], [], 'day', 1, ctx);
        expect(row.site_id).toBe('my-site');
        expect(row.tariff_id).toBe(42);
    });

    it('nets grid_power when an interval has both import and export', () => {
        const history = [makeEntry({ grid_energy_imported: 50, total_grid_energy_exported: 300 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.grid_power).toBe(-250); // 50 imported - 300 exported
    });

    it('nets battery_power when an interval has both charge and discharge', () => {
        const history = [makeEntry({ total_battery_charge: 20, total_battery_discharge: 120 })];
        const [row] = transformEnergyPoints(history, [], 'day', 1, CONTEXT);
        expect(row.battery_power).toBe(-100); // 20 charged - 120 discharged
    });
});
