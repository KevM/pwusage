import type { EdgeCategory, EdgeFrom, EdgeTo, FlowContext, FlowEdge, FlowModel, FlowNode, InstantPower, NodeKey, NodeRole } from './flow-model';
import type { EnergyData } from '../db';

export interface Rates {
  buyRate: number;
  sellRate: number;
}

const RATE_BASIS: Record<EdgeCategory, 'buy' | 'sell'> = {
  'solar-home':    'buy',
  'solar-battery': 'buy',
  'solar-export':  'sell',
  'battery-home':  'buy',
  'grid-home':     'buy',
  'grid-battery':  'buy',
  'battery-export':'sell',
};

const EPS = 1e-9;

const NODE_KEYS: NodeKey[] = ['solar', 'battery', 'grid', 'home'];

function makeEdge(
  from: EdgeFrom,
  to: EdgeTo,
  category: EdgeCategory,
  energy: number,
  rates: Rates,
): FlowEdge | null {
  if (energy <= EPS) return null;
  const rate = RATE_BASIS[category] === 'sell' ? rates.sellRate : rates.buyRate;
  return { from, to, category, energy, value: energy * rate };
}

/**
 * Solar-first merit-order allocation of an instant's flows.
 * Input must be in the canonical LIVE convention (see InstantPower).
 */
export function allocateEdges(p: InstantPower, rates: Rates): FlowEdge[] {
  const solar = Math.max(p.solar, 0);
  const load = Math.max(p.load, 0);
  const batteryDischarge = Math.max(p.battery, 0);
  const batteryCharge = Math.max(-p.battery, 0);
  const gridImport = Math.max(p.grid, 0);
  const gridExport = Math.max(-p.grid, 0);

  const solarToHome = Math.min(solar, load);
  const solarToBattery = Math.min(solar - solarToHome, batteryCharge);
  const solarToGrid = Math.min(solar - solarToHome - solarToBattery, gridExport);

  const batteryToHome = Math.min(batteryDischarge, load - solarToHome);
  const gridToHome = Math.min(gridImport, load - solarToHome - batteryToHome);

  const gridToBattery = Math.max(batteryCharge - solarToBattery, 0);
  const batteryToGrid = Math.max(gridExport - solarToGrid, 0);

  return [
    makeEdge('solar', 'home', 'solar-home', solarToHome, rates),
    makeEdge('solar', 'battery', 'solar-battery', solarToBattery, rates),
    makeEdge('solar', 'grid', 'solar-export', solarToGrid, rates),
    makeEdge('battery', 'home', 'battery-home', batteryToHome, rates),
    makeEdge('grid', 'home', 'grid-home', gridToHome, rates),
    makeEdge('grid', 'battery', 'grid-battery', gridToBattery, rates),
    makeEdge('battery', 'grid', 'battery-export', batteryToGrid, rates),
  ].filter((e): e is FlowEdge => e !== null);
}

export function deriveNodes(edges: FlowEdge[], soc?: number): Record<NodeKey, FlowNode> {
  const nodes = {} as Record<NodeKey, FlowNode>;
  for (const key of NODE_KEYS) {
    const outflow = edges.filter(e => e.from === key).reduce((s, e) => s + e.energy, 0);
    const inflow = edges.filter(e => e.to === key).reduce((s, e) => s + e.energy, 0);
    let role: NodeRole = 'idle';
    if (outflow > EPS && inflow > EPS) role = 'mixed';
    else if (outflow > EPS) role = 'source';
    else if (inflow > EPS) role = 'sink';
    nodes[key] = {
      key,
      total: outflow + inflow,
      role,
      ...(key === 'battery' && soc != null ? { soc } : {}),
    };
  }
  return nodes;
}

export interface SnapshotContext extends Omit<FlowContext, 'rangeStart'> {
  soc?: number;
}

export function buildSnapshotModel(power: InstantPower, ctx: SnapshotContext): FlowModel {
  const edges = allocateEdges(power, { buyRate: ctx.buyRate, sellRate: ctx.sellRate });
  return {
    basis: 'snapshot',
    nodes: deriveNodes(edges, ctx.soc),
    edges,
    context: { buyRate: ctx.buyRate, sellRate: ctx.sellRate, timestamp: ctx.timestamp },
  };
}

/** Wh -> kWh (matches sumTodayRows: divide by 1000). */
function whToKwh(wh: number): number {
  return wh / 1000;
}

/**
 * Convert a stored EnergyData row (Wh) to canonical kWh InstantPower.
 * Stored battery_power is + = charge, so NEGATE to match LIVE (+ = discharge).
 * grid_power keeps its sign (+ = import in both).
 */
export function energyDataToInstant(row: EnergyData): InstantPower {
  return {
    solar: whToKwh(row.solar_power),
    load: whToKwh(row.load_power),
    battery: -whToKwh(row.battery_power),
    grid: whToKwh(row.grid_power),
  };
}

export interface CumulativeContext extends FlowContext {
  rangeStart?: Date;
}

export function buildCumulativeModel(rows: EnergyData[], ctx: CumulativeContext): FlowModel {
  const rates = { buyRate: ctx.buyRate, sellRate: ctx.sellRate };
  const totals = new Map<EdgeCategory, { from: EdgeFrom; to: EdgeTo; energy: number }>();

  let latestSoc: { value: number; ts: number } | null = null;

  for (const row of rows) {
    for (const e of allocateEdges(energyDataToInstant(row), rates)) {
      const acc = totals.get(e.category);
      if (acc) acc.energy += e.energy;
      else totals.set(e.category, { from: e.from, to: e.to, energy: e.energy });
    }
    if (row.battery_soc != null) {
      const ts = row.timestamp.getTime();
      if (!latestSoc || ts > latestSoc.ts) latestSoc = { value: row.battery_soc, ts };
    }
  }

  const edges: FlowEdge[] = [...totals.entries()].map(([category, v]) =>
    makeEdge(v.from, v.to, category, v.energy, rates)!,
  ).filter((e): e is FlowEdge => e !== null);

  return {
    basis: 'cumulative',
    nodes: deriveNodes(edges, latestSoc?.value),
    edges,
    context: {
      buyRate: ctx.buyRate,
      sellRate: ctx.sellRate,
      timestamp: ctx.timestamp,
      rangeStart: ctx.rangeStart,
    },
  };
}

