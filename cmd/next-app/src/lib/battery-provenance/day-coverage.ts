/** Classify a local day's EnergyData coverage from its sample timestamps (ms).
 *  'complete' only when samples reach within `thresholdMs` of both ends. */
export type DayCoverage = 'empty' | 'partial' | 'complete';

export function classifyDayCoverage(
  timestampsMs: number[],
  dayStart: Date,
  dayEnd: Date,
  thresholdMs = 30 * 60 * 1000,
): DayCoverage {
  const inDay = timestampsMs.filter(t => t >= dayStart.getTime() && t < dayEnd.getTime());
  if (inDay.length === 0) return 'empty';
  const first = Math.min(...inDay);
  const last = Math.max(...inDay);
  const missingStart = first - dayStart.getTime() > thresholdMs;
  const missingEnd = dayEnd.getTime() - last > thresholdMs;
  return missingStart || missingEnd ? 'partial' : 'complete';
}
