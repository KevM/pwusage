import { describe, it, expect } from 'vitest';
import { allocateEdges, buildSnapshotModel, energyDataToInstant, buildCumulativeModel } from './build-flow-model';
import type { FlowEdge } from './flow-model';
import type { EnergyData } from '../db';

const row = (over: Partial<EnergyData>): EnergyData => ({
  timestamp: new Date('2026-06-08T12:00:00Z'),
  site_id: 's1', tariff_id: 1, tariff_schedule_id: null,
  load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null,
  ...over,
});

const rates = { buyRate: 0.40, sellRate: 0.10 };
const byCat = (edges: FlowEdge[]) =>
  Object.fromEntries(edges.map(e => [e.category, e.energy]));

describe('allocateEdges (LIVE convention: battery + = discharge, grid + = import)', () => {
  it('solar surplus splits home -> battery charge -> export', () => {
    // solar 7, load 3, battery charging 2 (-2), grid exporting 2 (-2)
    const edges = allocateEdges({ solar: 7, load: 3, battery: -2, grid: -2 }, rates);
    expect(byCat(edges)).toEqual({
      'solar-home': 3,
      'solar-battery': 2,
      'solar-export': 2,
    });
  });

  it('evening: solar -> home, battery discharge -> home, grid import -> home', () => {
    // solar 1, load 6, battery discharging 3 (+3), grid importing 2 (+2)
    const edges = allocateEdges({ solar: 1, load: 6, battery: 3, grid: 2 }, rates);
    expect(byCat(edges)).toEqual({
      'solar-home': 1,
      'battery-home': 3,
      'grid-home': 2,
    });
  });

  it('grid charges the battery beyond solar', () => {
    // solar 1, load 1, battery charging 3 (-3), grid importing 3 (+3)
    const edges = allocateEdges({ solar: 1, load: 1, battery: -3, grid: 3 }, rates);
    expect(byCat(edges)).toEqual({
      'solar-home': 1,
      'grid-battery': 3,
    });
  });

  it('assigns value = energy * buy rate for consumption, sell rate for export', () => {
    const edges = allocateEdges({ solar: 7, load: 3, battery: -2, grid: -2 }, rates);
    const home = edges.find(e => e.category === 'solar-home')!;
    const exp = edges.find(e => e.category === 'solar-export')!;
    expect(home.value).toBeCloseTo(3 * 0.40);
    expect(exp.value).toBeCloseTo(2 * 0.10);
  });

  it('conserves energy: sum of source outflow == sum of sink inflow', () => {
    const edges = allocateEdges({ solar: 5, load: 6, battery: 2, grid: -1 }, rates);
    const out = edges.reduce((s, e) => s + e.energy, 0); // every edge is one source->sink
    const sources = edges.reduce((s, e) => s + e.energy, 0);
    expect(out).toBeCloseTo(sources);
    // home inflow + exports == solar + discharge + import
    const inHome = edges.filter(e => e.to === 'home').reduce((s, e) => s + e.energy, 0);
    expect(inHome).toBeCloseTo(6);
  });

  it('returns no edges when everything is zero', () => {
    expect(allocateEdges({ solar: 0, load: 0, battery: 0, grid: 0 }, rates)).toEqual([]);
  });
});

describe('buildSnapshotModel', () => {
  const ctx = { buyRate: 0.40, sellRate: 0.10, timestamp: new Date('2026-06-08T18:00:00Z'), soc: 68 };

  it('builds a snapshot model with node roles and battery soc', () => {
    const model = buildSnapshotModel({ solar: 1, load: 6, battery: 3, grid: 2 }, ctx);
    expect(model.basis).toBe('snapshot');
    expect(model.nodes.solar.role).toBe('source');
    expect(model.nodes.home.role).toBe('sink');
    expect(model.nodes.battery.role).toBe('source'); // discharging
    expect(model.nodes.battery.soc).toBe(68);
    expect(model.nodes.home.total).toBeCloseTo(6);
    expect(model.context.buyRate).toBe(0.40);
  });

  it('marks idle nodes', () => {
    const model = buildSnapshotModel({ solar: 5, load: 5, battery: 0, grid: 0 }, ctx);
    expect(model.nodes.battery.role).toBe('idle');
    expect(model.nodes.grid.role).toBe('idle');
  });
});

describe('energyDataToInstant (stored convention: battery + = charge -> negate)', () => {
  it('negates stored battery_power and converts Wh -> kWh', () => {
    // stored battery_power +600 Wh = CHARGING -> canonical battery should be negative (charge)
    const p = energyDataToInstant(row({ solar_power: 600, load_power: 300, battery_power: 600, grid_power: -300 }));
    expect(p.solar).toBeCloseTo(0.6);
    expect(p.load).toBeCloseTo(0.3);
    expect(p.battery).toBeCloseTo(-0.6); // charging in canonical convention
    expect(p.grid).toBeCloseTo(-0.3);    // export unchanged
  });
});

describe('buildCumulativeModel', () => {
  const ctx = {
    buyRate: 0.40, sellRate: 0.10,
    timestamp: new Date('2026-06-08T13:00:00Z'),
    rangeStart: new Date('2026-06-08T00:00:00Z'),
  };

  it('sums per-interval edges by category', () => {
    const rows = [
      // midday: solar 600Wh, load 300, charging 200 (+200 stored), export 100 (-100)
      row({ solar_power: 600, load_power: 300, battery_power: 200, grid_power: -100 }),
      // evening: solar 0, load 600, discharging 400 (-400 stored), import 200 (+200)
      row({ solar_power: 0, load_power: 600, battery_power: -400, grid_power: 200 }),
    ];
    const model = buildCumulativeModel(rows, ctx);
    expect(model.basis).toBe('cumulative');
    const byCat = Object.fromEntries(model.edges.map(e => [e.category, Number(e.energy.toFixed(3))]));
    // interval 1: solar-home .3, solar-battery .2, solar-export .1
    // interval 2: battery-home .4, grid-home .2
    expect(byCat['solar-home']).toBeCloseTo(0.3);
    expect(byCat['solar-battery']).toBeCloseTo(0.2);
    expect(byCat['solar-export']).toBeCloseTo(0.1);
    expect(byCat['battery-home']).toBeCloseTo(0.4);
    expect(byCat['grid-home']).toBeCloseTo(0.2);
    expect(model.context.rangeStart).toBe(ctx.rangeStart);
  });

  it('uses latest non-null soc for the battery node', () => {
    const rows = [
      row({ battery_soc: 40, solar_power: 100, load_power: 100 }),
      row({ battery_soc: 55, solar_power: 100, load_power: 100, timestamp: new Date('2026-06-08T12:05:00Z') }),
    ];
    expect(buildCumulativeModel(rows, ctx).nodes.battery.soc).toBe(55);
  });
});

