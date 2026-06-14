/** Wall-clock hour (0–23) in `timeZone` for the given instant. */
export function localHourFor(now: Date, timeZone: string): number {
  const hh = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(now);
  return parseInt(hh, 10) % 24;
}

/** True when it's early morning (local hours 2–5) for the site — its previous day is fully elapsed. */
export function isInRollupBand(now: Date, timeZone: string, lo = 2, hi = 5): boolean {
  const h = localHourFor(now, timeZone);
  return h >= lo && h <= hi;
}
