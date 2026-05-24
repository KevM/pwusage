/** ≤80 holds at floor(SoC); 81–99 would clamp to 80, so hold-high at 100. */
export function computeTargetReserve(soc: number): number {
  const floor = Math.floor(soc);
  return floor <= 80 ? floor : 100;
}
