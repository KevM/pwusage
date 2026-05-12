import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { TodayEnergyChart } from './TodayEnergyChart';
import type { EnergyData } from '@/lib/db';

describe('TodayEnergyChart', () => {
	it('renders usage line from load_power data', () => {
		const todayStart = new Date('2026-05-11T00:00:00');
		const now = new Date('2026-05-11T12:00:00');
		const rows: EnergyData[] = [
			{
				timestamp: todayStart,
				site_id: 'test-site',
				tariff_id: 1,
				tariff_schedule_id: null,
				load_power: 1500,
				solar_power: 0,
				grid_power: 1500,
				battery_power: 0,
				battery_soc: 50,
			},
			{
				timestamp: new Date('2026-05-11T00:05:00'),
				site_id: 'test-site',
				tariff_id: 1,
				tariff_schedule_id: null,
				load_power: 2000,
				solar_power: 0,
				grid_power: 2000,
				battery_power: 0,
				battery_soc: 50,
			},
			{
				timestamp: now,
				site_id: 'test-site',
				tariff_id: 1,
				tariff_schedule_id: null,
				load_power: 1000,
				solar_power: 500,
				grid_power: 500,
				battery_power: 0,
				battery_soc: 50,
			},
		];

		const html = renderToStaticMarkup(
			<TodayEnergyChart rows={rows} todayStart={todayStart} now={now} timezone="America/Los_Angeles" />
		);

		// Check legend includes Usage
		expect(html).toContain('Usage');
	});

	it('handles no data without crashing', () => {
		const todayStart = new Date('2026-05-11T00:00:00');
		const now = new Date('2026-05-11T12:00:00');

		const html = renderToStaticMarkup(
			<TodayEnergyChart rows={[]} todayStart={todayStart} now={now} timezone="America/Los_Angeles" />
		);

		expect(html).toContain('Not enough data yet');
	});
});
