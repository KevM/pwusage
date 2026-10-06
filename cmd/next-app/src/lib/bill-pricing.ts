interface BillUsage {
    tariff: { name?: string | null };
    touName?: string;
    gridUsage: number;
    buyRate?: number;
    sellRate?: number;
    cost?: number;
}

/**
 * Net the requested billing window by tariff/TOU name, across rate changes.
 * Keep each rate bucket's measured energy intact. Offset opposing balances
 * proportionally, then price only the remaining energy at its original rates.
 * This preserves historical pricing and does not depend on input row order.
 */
export function priceBillUsage(usage: BillUsage[]): void {
    const groups = new Map<string, BillUsage[]>();
    for (const row of usage) {
        const key = JSON.stringify([row.tariff.name || 'Unknown', row.touName || 'Unknown']);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        const imports = group.reduce((sum, row) => sum + Math.max(row.gridUsage, 0), 0);
        const exports = group.reduce((sum, row) => sum + Math.max(-row.gridUsage, 0), 0);
        const net = imports - exports;
        for (const row of group) {
            row.cost = 0;
            if (net > 0 && row.gridUsage > 0) {
                row.cost = (row.gridUsage / 1000) * (net / imports) * (row.buyRate ?? 0);
            } else if (net < 0 && row.gridUsage < 0) {
                row.cost = (row.gridUsage / 1000) * (-net / exports) * Math.abs(row.sellRate ?? 0);
            }
        }
    }
}
