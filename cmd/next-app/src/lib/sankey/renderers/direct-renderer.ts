import type { FlowModel, NodeKey } from '../flow-model';
import type { SankeyRenderer } from './types';
import { edgeStyle } from '../value-color';

const W = 760;
const H = 340;
const PAD = 28;
const BAR_W = 14;
const GAP = 22;
const MIN_BAR = 3;

const LEFT_BAR_X = 174;                 // left edge of the source bars
const RIGHT_BAR_X = W - 174 - BAR_W;    // left edge of the sink bars
const RIBBON_X1 = LEFT_BAR_X + BAR_W;   // ribbons start at the right of source bars
const RIBBON_X2 = RIGHT_BAR_X;          // and end at the left of sink bars
const AVAIL_H = H - 2 * PAD;

// Sources occupy the left column, sinks the right. The two reversible nodes
// (battery, grid) may appear in both columns when they have flow in both
// directions (e.g. the cumulative "Today" view: charged midday, discharged later).
const LEFT_ORDER: NodeKey[] = ['solar', 'battery', 'grid'];
const RIGHT_ORDER: NodeKey[] = ['home', 'battery', 'grid'];

const NODE_LABEL: Record<NodeKey, string> = {
  solar: '☀️ SOLAR', home: '🏠 HOME', battery: '🔋 BATTERY', grid: '🔌 GRID',
};

interface Placed {
  key: NodeKey;
  total: number;   // directional energy: outflow for sources, inflow for sinks
  yTop: number;
  barH: number;
  center: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Horizontal Sankey ribbon of constant vertical thickness `w`. */
function ribbonBand(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const xm = (x1 + x2) / 2;
  const t = w / 2;
  return [
    `M ${x1} ${y1 - t}`,
    `C ${xm} ${y1 - t}, ${xm} ${y2 - t}, ${x2} ${y2 - t}`,
    `L ${x2} ${y2 + t}`,
    `C ${xm} ${y2 + t}, ${xm} ${y1 + t}, ${x1} ${y1 + t}`,
    'Z',
  ].join(' ');
}

/** Lay out a column of nodes, vertically centered, bar heights ∝ total * scale. */
function layout(order: NodeKey[], totals: Map<NodeKey, number>, scale: number): Placed[] {
  const present = order.filter(k => (totals.get(k) ?? 0) > 0);
  const bars = present.map(key => Math.max((totals.get(key) ?? 0) * scale, MIN_BAR));
  const usedH = bars.reduce((s, h) => s + h, 0) + Math.max(present.length - 1, 0) * GAP;
  let y = PAD + (AVAIL_H - usedH) / 2;
  return present.map((key, i) => {
    const barH = bars[i];
    const placed: Placed = { key, total: totals.get(key) ?? 0, yTop: y, barH, center: y + barH / 2 };
    y += barH + GAP;
    return placed;
  });
}

export const directRenderer: SankeyRenderer = (model: FlowModel, theme) => {
  const unit = model.basis === 'snapshot' ? 'kW' : 'kWh';
  const valueUnit = model.basis === 'snapshot' ? '/hr' : '';

  // Directional totals per side.
  const outTotals = new Map<NodeKey, number>();
  const inTotals = new Map<NodeKey, number>();
  for (const e of model.edges) {
    outTotals.set(e.from, (outTotals.get(e.from) ?? 0) + e.energy);
    inTotals.set(e.to, (inTotals.get(e.to) ?? 0) + e.energy);
  }

  const totalLeft = [...outTotals.values()].reduce((s, v) => s + v, 0);
  const totalRight = [...inTotals.values()].reduce((s, v) => s + v, 0);
  const nLeft = LEFT_ORDER.filter(k => (outTotals.get(k) ?? 0) > 0).length;
  const nRight = RIGHT_ORDER.filter(k => (inTotals.get(k) ?? 0) > 0).length;

  if (model.edges.length === 0 || totalLeft <= 0 || totalRight <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="ui-monospace,monospace"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="currentColor" fill-opacity="0.6">No energy flow</text></svg>`;
  }

  const scale = Math.min(
    (AVAIL_H - Math.max(nLeft - 1, 0) * GAP) / totalLeft,
    (AVAIL_H - Math.max(nRight - 1, 0) * GAP) / totalRight,
  );

  const left = layout(LEFT_ORDER, outTotals, scale);
  const right = layout(RIGHT_ORDER, inTotals, scale);
  const leftIndex = new Map(left.map((p, i) => [p.key, i]));
  const rightIndex = new Map(right.map((p, i) => [p.key, i]));

  // Running stack offset along each node's edge so ribbons sit side-by-side and
  // fill the bar exactly (bar height == sum of its ribbon widths).
  const leftOffset = new Map<NodeKey, number>();
  const rightOffset = new Map<NodeKey, number>();
  for (const p of left) leftOffset.set(p.key, p.center - (p.total * scale) / 2);
  for (const p of right) rightOffset.set(p.key, p.center - (p.total * scale) / 2);

  // Order edges so attachments stack without crossing: by source row, then sink row.
  const ordered = [...model.edges].sort((a, b) => {
    const byFrom = leftIndex.get(a.from)! - leftIndex.get(b.from)!;
    if (byFrom !== 0) return byFrom;
    return rightIndex.get(a.to)! - rightIndex.get(b.to)!;
  });

  const ribbons = ordered
    .map(edge => {
      const w = edge.energy * scale;
      const oL = leftOffset.get(edge.from)!;
      const oR = rightOffset.get(edge.to)!;
      leftOffset.set(edge.from, oL + w);
      rightOffset.set(edge.to, oR + w);
      const y1 = oL + w / 2;
      const y2 = oR + w / 2;

      const style = edgeStyle(edge.category, theme);
      const dash = theme === 'mono' && style.dashed ? ' stroke="#000000" stroke-width="1" stroke-dasharray="3 2"' : '';
      const fill = theme === 'mono' && style.dashed ? 'white' : style.color;
      const tip = `${style.label} · ${edge.energy.toFixed(2)} ${unit} · $${edge.value.toFixed(2)}${valueUnit} ${style.verb}`;
      return `<path class="ribbon" d="${ribbonBand(RIBBON_X1, y1, RIBBON_X2, y2, w)}" fill="${fill}" fill-opacity="0.78"${dash}><title>${esc(tip)}</title></path>`;
    })
    .join('');

  const bar = (p: Placed, side: 'left' | 'right'): string => {
    const x = side === 'left' ? LEFT_BAR_X : RIGHT_BAR_X;
    const node = model.nodes[p.key];
    const soc = p.key === 'battery' && node.soc != null ? ` ${Math.round(node.soc)}%` : '';
    const labelX = side === 'left' ? LEFT_BAR_X - 12 : RIGHT_BAR_X + BAR_W + 12;
    const anchor = side === 'left' ? 'end' : 'start';
    const name = `${esc(NODE_LABEL[p.key])}${soc}`;
    const total = `${p.total.toFixed(2)} ${unit}`;
    return [
      `<rect x="${x}" y="${p.yTop}" width="${BAR_W}" height="${p.barH}" rx="2" fill="currentColor" fill-opacity="0.85"/>`,
      `<text x="${labelX}" y="${p.center - 2}" text-anchor="${anchor}" font-size="13" font-weight="700" fill="currentColor">${name}</text>`,
      `<text x="${labelX}" y="${p.center + 14}" text-anchor="${anchor}" font-size="11" fill="currentColor" fill-opacity="0.75">${esc(total)}</text>`,
    ].join('');
  };

  const bars = [
    ...left.map(p => bar(p, 'left')),
    ...right.map(p => bar(p, 'right')),
  ].join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="ui-monospace,monospace">${ribbons}${bars}</svg>`;
};
