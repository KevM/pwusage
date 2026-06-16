// extended-grid.ts — pure data model for the N-column scenario grid (Phase D).
import type { EnergyHourlyRow } from '../db';
import type { PlanTimeline } from './plan-timeline';
import { priceColumn } from './roi-service';

export type ColumnType = 'metered' | 'fixed' | 'tou';

/** A plan column to price. `timeline` is server-only (a function) and never serialized. */
export interface GridColumnInput {
    name: string;
    type: ColumnType;
    isMetered: boolean; // the single "you are here" column
    timeline: PlanTimeline;
}

export interface GridCell {
    value: number;    // cumulative dollars over all history
    cheapest: boolean; // row-min (only when >1 column)
    here: boolean;     // metered × Solar+Batt
}

export type ConfigKey = 'noSolar' | 'solar' | 'solarBattery';

export interface GridRow {
    config: ConfigKey;
    label: string;
    cells: GridCell[]; // index-aligned with columns
}

/** Plain, serializable model handed page → view (no timelines/functions). */
export interface ExtendedGridModel {
    columns: { name: string; type: ColumnType }[];
    rows: GridRow[];
}

const CONFIGS: { key: ConfigKey; label: string }[] = [
    { key: 'noSolar', label: 'No Solar' },
    { key: 'solar', label: 'Solar' },
    { key: 'solarBattery', label: 'Solar+Batt' },
];

/** Map priceColumn over the columns and assemble the 3×N grid with cheapest/here flags. */
export function buildExtendedGrid(rows: EnergyHourlyRow[], columns: GridColumnInput[]): ExtendedGridModel {
    const bills = columns.map(c => priceColumn(c.timeline, rows));
    const gridRows: GridRow[] = CONFIGS.map(({ key, label }) => {
        const values = bills.map(b => b[key]);
        const min = values.length ? Math.min(...values) : 0;
        const cells: GridCell[] = values.map((value, i) => ({
            value,
            cheapest: columns.length > 1 && value === min,
            here: key === 'solarBattery' && columns[i].isMetered,
        }));
        return { config: key, label, cells };
    });
    return { columns: columns.map(c => ({ name: c.name, type: c.type })), rows: gridRows };
}
