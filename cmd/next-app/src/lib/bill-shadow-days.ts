import { formatSiteDate } from './date-utils';

/** One site-local day of a bill shadow report: net grid energy (Wh) and the last sample's time. */
export interface ShadowDay {
    day: string;
    gridWh: number;
    last: string | null;
}

export interface ShadowDayDiff {
    day: string;
    serverGridWh: number | null;
    localGridWh: number | null;
    serverLast: string | null;
    localLast: string | null;
}

/** A day whose totals differ by more than this (Wh) is reported; the phone rounds each slot to 0.01 Wh. */
const GRID_TOLERANCE_WH = 0.5;

/** Net grid energy and last sample time per site-local day, oldest first. */
export function summarizeShadowDays(
    rows: readonly { timestamp: Date; grid_power: number }[],
    timeZone: string,
): ShadowDay[] {
    const byDay = new Map<string, { gridWh: number; last: Date }>();
    for (const row of rows) {
        const day = formatSiteDate(row.timestamp, timeZone);
        const entry = byDay.get(day);
        if (!entry) {
            byDay.set(day, { gridWh: row.grid_power, last: row.timestamp });
        } else {
            entry.gridWh += row.grid_power;
            if (row.timestamp > entry.last) entry.last = row.timestamp;
        }
    }
    return [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, { gridWh, last }]) => ({ day, gridWh, last: last.toISOString() }));
}

/** Days where the server and phone disagree on grid total or last sample, oldest first. */
export function compareShadowDays(server: readonly ShadowDay[], local: readonly ShadowDay[]): ShadowDayDiff[] {
    const serverByDay = new Map(server.map(d => [d.day, d]));
    const localByDay = new Map(local.map(d => [d.day, d]));
    const days = [...new Set([...serverByDay.keys(), ...localByDay.keys()])].sort();
    const diffs: ShadowDayDiff[] = [];
    for (const day of days) {
        const s = serverByDay.get(day);
        const l = localByDay.get(day);
        const sameTotals = s && l && Math.abs(s.gridWh - l.gridWh) <= GRID_TOLERANCE_WH;
        const sameLast = s && l && (s.last === null || l.last === null ? s.last === l.last : Date.parse(s.last) === Date.parse(l.last));
        if (sameTotals && sameLast) continue;
        diffs.push({
            day,
            serverGridWh: s?.gridWh ?? null,
            localGridWh: l?.gridWh ?? null,
            serverLast: s?.last ?? null,
            localLast: l?.last ?? null,
        });
    }
    return diffs;
}
