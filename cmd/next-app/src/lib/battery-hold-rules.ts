export interface ReservePlan {
  /** The reserve to send if the user makes no explicit choice. */
  target: number;
  /** True only for 85 < SoC < 95, where 80 vs 100 is a real trade-off. */
  ambiguous: boolean;
  /** Present iff ambiguous: the two values to offer the user. */
  options?: [80, 100];
}

/**
 * Decide the reserve to send when parking. In the 81–99 clamp band the Powerwall
 * forces any value to 80, so the only real choices are 80 (discharge to 80, then
 * hold) or 100 (hold completely). Snap the edges to the nearest of those; only the
 * 85–95 middle is genuinely ambiguous and asks the user. Boundaries are exclusive
 * at 85 and 95: SoC exactly 85 → 80, exactly 95 → 100.
 */
export function planReserve(soc: number): ReservePlan {
  const floor = Math.floor(soc);
  if (soc <= 80) return { target: floor, ambiguous: false };
  if (soc <= 85) return { target: 80, ambiguous: false };
  if (soc < 95) return { target: 100, ambiguous: true, options: [80, 100] };
  return { target: 100, ambiguous: false };
}

/** Scalar target only. Kept for callers (e.g. the button label) that just need the number. */
export function computeTargetReserve(soc: number): number {
  return planReserve(soc).target;
}
