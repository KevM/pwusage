export type NodeKey = 'solar' | 'battery' | 'grid' | 'home';
export type FlowBasis = 'snapshot' | 'cumulative';

export type EdgeCategory =
  | 'solar-home' | 'solar-battery' | 'solar-export'
  | 'battery-home' | 'grid-home' | 'grid-battery' | 'battery-export';

export type EdgeFrom = 'solar' | 'battery' | 'grid';
export type EdgeTo = 'home' | 'battery' | 'grid';

export interface FlowEdge {
  from: EdgeFrom;
  to: EdgeTo;
  energy: number;   // kW (snapshot) or kWh (cumulative), >= 0
  value: number;    // $/hr (snapshot) or $ (cumulative), >= 0 magnitude
  category: EdgeCategory;
}

export type NodeRole = 'source' | 'sink' | 'mixed' | 'idle';

export interface FlowNode {
  key: NodeKey;
  total: number;    // energy through node, >= 0
  role: NodeRole;
  soc?: number;     // battery only, 0..100
}

export interface FlowContext {
  buyRate: number;
  sellRate: number;
  timestamp: Date;
  rangeStart?: Date;   // cumulative window start
}

export interface FlowModel {
  basis: FlowBasis;
  nodes: Record<NodeKey, FlowNode>;
  edges: FlowEdge[];
  context: FlowContext;
}

/**
 * Canonical signed power/energy input. LIVE convention:
 *   battery: + = discharge, - = charge
 *   grid:    + = import,    - = export
 */
export interface InstantPower {
  solar: number;   // >= 0
  load: number;    // >= 0
  battery: number;
  grid: number;
}
