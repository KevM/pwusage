import { addCalendarDays, isProtectedSpan, spanChoiceKind, type ExistingSpan, type NewSpanRow } from './tariff-timeline';

export interface DesiredEstimate {
  tariffId: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  selectionId?: number | null;
}
export interface TeslaAnchor { tariffId: number; startDate: string }
export interface EstimateLayout { deleteIds: number[]; inserts: NewSpanRow[]; changed: Array<{ from: string; to: string | null }> }

type Interval = { from: string; to: string | null };
type Row = NewSpanRow & { originalId?: number };
const end = (value: string | null): string => value ?? '9999-12-31';
const overlap = (a: Interval, b: Interval): boolean => a.from <= end(b.to) && b.from <= end(a.to);
const interval = (r: { effectiveFrom: string; effectiveTo: string | null }): Interval => ({ from: r.effectiveFrom, to: r.effectiveTo });

function subtract(source: Interval, blocked: Interval): Interval[] {
  if (!overlap(source, blocked)) return [source];
  const parts: Interval[] = [];
  if (source.from < blocked.from) parts.push({ from: source.from, to: addCalendarDays(blocked.from, -1) });
  if (end(source.to) > end(blocked.to) && blocked.to !== null) parts.push({ from: addCalendarDays(blocked.to, 1), to: source.to });
  return parts;
}
function uncovered(source: Interval, blockers: Interval[]): Interval[] {
  return blockers.reduce((parts, blocker) => parts.flatMap(part => subtract(part, blocker)), [source]);
}
function rowKey(row: NewSpanRow): string {
  const kind = spanChoiceKind(row);
  const trackedSelectionId = kind === 'owner' || row.source === 'tesla' ? (row.selectionId ?? null) : null;
  return JSON.stringify([row.tariffId, row.source, row.effectiveFrom, row.effectiveTo, row.updatedByUserId, kind, trackedSelectionId]);
}
function toNewSpanRow(row: Row): NewSpanRow {
  return {
    tariffId: row.tariffId,
    source: row.source,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    updatedByUserId: row.updatedByUserId,
    ...(row.selectionId !== undefined ? { selectionId: row.selectionId } : {}),
    ...(row.choiceKind !== undefined ? { choiceKind: row.choiceKind } : {}),
  };
}

export function layoutTimeline(existing: ExistingSpan[], anchors: TeslaAnchor[], desired: DesiredEstimate[]): EstimateLayout {
  let rows: Row[] = existing
    .filter(r => r.source !== 'estimated' || isProtectedSpan(r))
    .map(r => ({
      tariffId: r.tariffId,
      source: r.source,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      updatedByUserId: r.updatedByUserId,
      ...(r.selectionId !== undefined ? { selectionId: r.selectionId } : {}),
      ...(r.choiceKind !== undefined ? { choiceKind: r.choiceKind } : {}),
      originalId: r.id,
    }));
  const ordered = [...rows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (const row of ordered) {
    if (row.source !== 'tesla' || isProtectedSpan(row)) continue;
    const target = anchors.find(a => a.tariffId === row.tariffId)?.startDate;
    if (!target || target === row.effectiveFrom || (row.effectiveTo !== null && target > row.effectiveTo)) continue;
    if (target > row.effectiveFrom) {
      const freed = { from: row.effectiveFrom, to: addCalendarDays(target, -1) };
      if (uncovered(freed, desired.map(interval)).length === 0) row.effectiveFrom = target;
      continue;
    }
    let start = target;
    for (const other of rows) {
      if (other === row || other.effectiveFrom >= row.effectiveFrom || end(other.effectiveTo) < start) continue;
      if (isProtectedSpan(other)) {
        if (other.effectiveTo === null) start = row.effectiveFrom;
        else start = [start, addCalendarDays(other.effectiveTo, 1)].sort().at(-1) ?? start;
      }
    }
    if (start >= row.effectiveFrom) continue;
    const expanded = { from: start, to: addCalendarDays(row.effectiveFrom, -1) };
    rows = rows.flatMap(other => {
      if (other === row || other.source !== 'tesla' || isProtectedSpan(other) || !overlap(interval(other), expanded)) return [other];
      return subtract(interval(other), expanded).map(part => ({ ...other, effectiveFrom: part.from, effectiveTo: part.to }));
    });
    row.effectiveFrom = start;
  }
  for (const estimate of [...desired].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))) {
    for (const part of uncovered(interval(estimate), rows.map(interval))) {
      rows.push({
        tariffId: estimate.tariffId,
        source: 'estimated',
        effectiveFrom: part.from,
        effectiveTo: part.to,
        updatedByUserId: null,
        ...(estimate.selectionId !== undefined ? { selectionId: estimate.selectionId } : {}),
      });
    }
  }
  rows.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const existingKeys = new Map(existing.map(r => [r.id, rowKey(r)]));
  // Preserve identical rows, including estimates and protected owner-selected estimated/restored rows, so a repeated layout is a no-op.
  const retained = new Set<number>();
  for (const row of rows) {
    const match = existing.find(r => !retained.has(r.id) && rowKey(r) === rowKey(row));
    if (match) retained.add(match.id);
  }
  const deleteIds = existing.filter(r => !retained.has(r.id)).map(r => r.id);
  const inserts = rows
    .filter(row => !existing.some(r => retained.has(r.id) && existingKeys.get(r.id) === rowKey(row)))
    .map(toNewSpanRow);
  const boundaries = new Set<string>();
  for (const row of [...existing, ...rows]) {
    boundaries.add(row.effectiveFrom);
    if (row.effectiveTo !== null) boundaries.add(addCalendarDays(row.effectiveTo, 1));
  }
  const points = [...boundaries].sort();
  const changed: EstimateLayout['changed'] = [];
  for (let i = 0; i < points.length; i++) {
    const from = points[i];
    const oldId = existing.find(r => r.effectiveFrom <= from && end(r.effectiveTo) >= from)?.tariffId;
    const newId = rows.find(r => r.effectiveFrom <= from && end(r.effectiveTo) >= from)?.tariffId;
    if (oldId === newId) continue;
    const to = i + 1 < points.length ? addCalendarDays(points[i + 1], -1) : null;
    const previous = changed.at(-1);
    if (previous?.to && addCalendarDays(previous.to, 1) === from) previous.to = to;
    else changed.push({ from, to });
  }
  return { deleteIds, inserts, changed };
}
