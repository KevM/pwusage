export interface SocSample {
    timestamp: number;
    soc: number;
}

export interface SocCheckpoint {
    timestamp: number;
    soc: number;
    delta: number | null;
}

export interface BuildSocCheckpointsOptions {
    samples: SocSample[];
    startTime: number;
    endTime: number;
    anchorTimestamps?: number[];
    baseAnchorMs?: number;
    rapidAnchorMs?: number;
    deltaThreshold?: number;
    rapidSegmentDeltaThreshold?: number;
}

function uniqueSortedTimestamps(values: number[]): number[] {
    return values
        .slice()
        .sort((a, b) => a - b)
        .filter((value, idx, arr) => idx === 0 || value !== arr[idx - 1]);
}

export function interpolateSocAt(samples: SocSample[], ts: number): number | null {
    if (samples.length === 0) return null;
    if (ts <= samples[0].timestamp) return samples[0].soc;
    if (ts >= samples[samples.length - 1].timestamp) return samples[samples.length - 1].soc;

    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (samples[mid].timestamp < ts) lo = mid + 1;
        else hi = mid;
    }

    const right = samples[lo];
    const left = samples[Math.max(0, lo - 1)];
    if (!left || !right) return null;
    if (right.timestamp === left.timestamp) return left.soc;
    const t = (ts - left.timestamp) / (right.timestamp - left.timestamp);
    return left.soc + (right.soc - left.soc) * t;
}

export function buildSocCheckpoints(options: BuildSocCheckpointsOptions): SocCheckpoint[] {
    const samples = options.samples
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp);
    if (samples.length === 0) return [];

    const startTime = options.startTime;
    const endTime = options.endTime;
    const baseAnchorMs = options.baseAnchorMs ?? (4 * 60 * 60 * 1000);
    const rapidAnchorMs = options.rapidAnchorMs ?? (2 * 60 * 60 * 1000);
    const deltaThreshold = options.deltaThreshold ?? 20;
    const rapidSegmentDeltaThreshold = options.rapidSegmentDeltaThreshold ?? 20;

    const anchorTimestamps = options.anchorTimestamps
        ? uniqueSortedTimestamps(options.anchorTimestamps).filter((ts) => ts >= startTime && ts <= endTime)
        : (() => {
            const firstAnchor = Math.floor(startTime / baseAnchorMs) * baseAnchorMs;
            const generated: number[] = [];
            for (let ts = firstAnchor; ts <= endTime; ts += baseAnchorMs) {
                if (ts >= startTime) generated.push(ts);
            }
            return generated;
        })();

    const baseAnchors = anchorTimestamps
        .map((ts) => {
            const soc = interpolateSocAt(samples, ts);
            return soc === null ? null : { timestamp: ts, soc };
        })
        .filter((point): point is SocSample => point !== null);

    const rapidAnchors: SocSample[] = [];
    for (let i = 0; i < baseAnchors.length - 1; i++) {
        const left = baseAnchors[i];
        const right = baseAnchors[i + 1];
        const deltaSoc = Math.abs(right.soc - left.soc);
        const durationMs = right.timestamp - left.timestamp;
        if (!(deltaSoc >= rapidSegmentDeltaThreshold && durationMs <= baseAnchorMs)) continue;

        for (let ts = left.timestamp + rapidAnchorMs; ts < right.timestamp; ts += rapidAnchorMs) {
            const soc = interpolateSocAt(samples, ts);
            if (soc !== null) rapidAnchors.push({ timestamp: ts, soc });
        }
    }

    const candidates = [
        ...baseAnchors.map((point) => ({ ...point, force: false })),
        ...rapidAnchors.map((point) => ({ ...point, force: true })),
        { timestamp: samples[0].timestamp, soc: samples[0].soc, force: true },
        { timestamp: samples[samples.length - 1].timestamp, soc: samples[samples.length - 1].soc, force: true }
    ]
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((item, idx, arr) => idx === 0 || item.timestamp !== arr[idx - 1].timestamp);

    const selected: SocCheckpoint[] = [];
    for (let i = 0; i < candidates.length; i++) {
        const point = candidates[i];
        if (i === 0) {
            selected.push({ timestamp: point.timestamp, soc: point.soc, delta: null });
            continue;
        }
        const prev = selected[selected.length - 1];
        const delta = point.soc - prev.soc;
        const isLast = i === candidates.length - 1;
        if (point.force || Math.abs(delta) >= deltaThreshold || isLast) {
            selected.push({ timestamp: point.timestamp, soc: point.soc, delta });
        }
    }

    return selected;
}
