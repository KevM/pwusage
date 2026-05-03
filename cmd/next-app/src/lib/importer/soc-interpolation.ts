export interface SocSample {
    timestampMs: number;
    soc: number;
}

export function buildSocSamples(
    entries: { timestamp: string; percentage_charged: number }[]
): SocSample[] {
    const map = new Map<number, number>();
    for (const e of entries) {
        const timestampMs = new Date(e.timestamp).getTime();
        if (!Number.isNaN(timestampMs)) {
            map.set(timestampMs, e.percentage_charged);
        }
    }
    return Array.from(map.entries())
        .map(([timestampMs, soc]) => ({ timestampMs, soc }))
        .sort((a, b) => a.timestampMs - b.timestampMs);
}

export function findNearestSoc(
    sortedSamples: SocSample[],
    targetMs: number,
    maxGapMs: number = 5 * 60 * 1000
): number | null {
    if (sortedSamples.length === 0) return null;

    let lo = 0;
    let hi = sortedSamples.length - 1;

    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (sortedSamples[mid].timestampMs < targetMs) lo = mid + 1;
        else hi = mid;
    }

    const candidates: SocSample[] = [sortedSamples[lo]];
    if (lo > 0) candidates.push(sortedSamples[lo - 1]);
    if (lo + 1 < sortedSamples.length) candidates.push(sortedSamples[lo + 1]);

    let best: SocSample | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
        const d = Math.abs(c.timestampMs - targetMs);
        if (d < bestDistance) {
            bestDistance = d;
            best = c;
        }
    }

    if (best === null || bestDistance > maxGapMs) return null;
    return best.soc;
}
