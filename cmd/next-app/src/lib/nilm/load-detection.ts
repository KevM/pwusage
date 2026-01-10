
import { PowerData } from './types';

export interface LoadEvent {
    startTime: Date;
    endTime: Date;
    durationMinutes: number;
    kwh: number;
    averagePower: number;
    maxPower: number;
    minPower: number;
    tariffId?: number;
}

/**
 * Detects significant load events using Sliding Window Gradient Detection.
 * Enhanced with "Return to Baseline" logic to handle slowly tapering loads.
 * 
 * Algorithm:
 * 1. Sliding Window Gradient to detect edges.
 * 2. LIFO Stack for matching Rising/Falling edges.
 * 3. Continuous "Return to Baseline" check to close events that lack a sharp falling edge.
 * 
 * @param data Array of PowerData points (normalized to Watts)
 * @param thresholdPower Minimum step change (in Watts).
 */
export function detectLoads(data: PowerData[], thresholdPower: number = 1000): LoadEvent[] {
    const events: LoadEvent[] = [];
    const windowSize = 3;

    if (data.length < windowSize * 2 + 1) return [];

    const getAvg = (start: number, end: number) => {
        let sum = 0;
        let count = 0;
        for (let i = start; i < end; i++) {
            if (i >= 0 && i < data.length) {
                sum += data[i].powerWatts;
                count++;
            }
        }
        return count > 0 ? sum / count : 0;
    };

    // Pre-calculate gradients and means
    const gradients: { index: number, val: number, preMean: number, postMean: number }[] = [];

    for (let i = windowSize; i <= data.length - windowSize; i++) {
        const preMean = getAvg(i - windowSize, i);
        const postMean = getAvg(i, i + windowSize);
        gradients.push({ index: i, val: postMean - preMean, preMean, postMean });
    }

    // Stack of active load starts
    const activeLoads: Array<{
        startIndex: number;
        startTime: Date;
        magnitude: number;
        baseline: number; // Avg power before event
        tariffId?: number
    }> = [];

    // Iterate
    for (let k = 0; k < gradients.length; k++) {
        const grad = gradients[k];
        const val = grad.val;
        const absVal = Math.abs(val);
        const point = data[grad.index];

        // 1. CHECK "RETURN TO BASELINE" FOR ACTIVE LOADS
        // If current level (postMean) drops near the baseline of an active event, close it.
        // This handles cases where the drop is gradual or the falling edge was missed.

        for (let j = activeLoads.length - 1; j >= 0; j--) {
            const load = activeLoads[j];
            // Condition: Current Level <= Baseline + Tolerance
            // Tolerance: 25% of magnitude or Fixed 400W? 
            // Use stricter of 400W or 20%.
            const tolerance = Math.max(400, load.magnitude * 0.2);

            if (grad.postMean <= (load.baseline + tolerance)) {
                // Event Ended via Baseline Return
                // Use current time as end time
                const endTime = point.timestamp;
                const durationMs = endTime.getTime() - load.startTime.getTime();
                const durationMinutes = durationMs / (1000 * 60);

                // If duration is too short (<5m) and we are only "returning to baseline" right after start?
                // Only close if duration > window? (15 min).
                if (durationMinutes < 10) continue; // Let it run, maybe it's just noise.

                // Calculate Stats
                const averagePower = load.magnitude; // Approx
                const kwh = (averagePower / 1000) * (durationMinutes / 60);

                let maxP = -Infinity;
                let minP = Infinity;
                if (load.startIndex < grad.index) {
                    for (let p = load.startIndex; p < grad.index; p++) {
                        const w = data[p].powerWatts;
                        if (w > maxP) maxP = w;
                        if (w < minP) minP = w;
                    }
                } else { maxP = averagePower; minP = averagePower; }

                events.push({
                    startTime: load.startTime,
                    endTime: endTime,
                    durationMinutes: Math.round(durationMinutes * 10) / 10,
                    averagePower: Math.round(averagePower),
                    maxPower: maxP,
                    minPower: minP,
                    kwh: Math.round(kwh * 100) / 100,
                    tariffId: load.tariffId
                });

                // Remove
                activeLoads.splice(j, 1);
            }
        }

        // 2. DETECT NEW EDGES (Gradient Peaks)

        if (absVal < thresholdPower) continue;

        // Local Peak & Debounce Logic
        // Simple optimization: If k-1 was also > threshold, we might have triggered already.
        // We rely on "clean" starts.
        let isPeak = true;
        if (k > 0 && Math.abs(gradients[k - 1].val) > absVal) isPeak = false;
        if (k < gradients.length - 1 && Math.abs(gradients[k + 1].val) > absVal) isPeak = false;

        if (!isPeak) continue;

        if (val > 0) {
            // RISING EDGE
            activeLoads.push({
                startIndex: grad.index,
                startTime: point.timestamp,
                magnitude: val,
                baseline: grad.preMean,
                tariffId: point.tariffId
            });
        } else {
            // FALLING EDGE (val < 0)
            const dropMag = Math.abs(val);

            // Match to active load
            let matchIndex = -1;

            for (let j = activeLoads.length - 1; j >= 0; j--) {
                const load = activeLoads[j];
                const diff = Math.abs(load.magnitude - dropMag);
                const percentError = diff / load.magnitude;

                // Relaxed Tolerance: 40%
                if (percentError < 0.40) {
                    matchIndex = j;
                    break;
                }
            }

            if (matchIndex !== -1) {
                // Close Event
                const load = activeLoads[matchIndex];
                const endTime = point.timestamp;
                const durationMs = endTime.getTime() - load.startTime.getTime();
                const durationMinutes = durationMs / (1000 * 60);

                const averagePower = (load.magnitude + dropMag) / 2;
                const kwh = (averagePower / 1000) * (durationMinutes / 60);

                let maxP = -Infinity;
                let minP = Infinity;
                if (load.startIndex < grad.index) {
                    for (let p = load.startIndex; p < grad.index; p++) {
                        const w = data[p].powerWatts;
                        if (w > maxP) maxP = w;
                        if (w < minP) minP = w;
                    }
                } else { maxP = averagePower; minP = averagePower; }

                events.push({
                    startTime: load.startTime,
                    endTime: endTime,
                    durationMinutes: Math.round(durationMinutes * 10) / 10,
                    averagePower: Math.round(averagePower),
                    maxPower: maxP,
                    minPower: minP,
                    kwh: Math.round(kwh * 100) / 100,
                    tariffId: load.tariffId
                });

                activeLoads.splice(matchIndex, 1);
            }
        }
    }

    return events.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}
