import { describe, expect, it } from 'vitest';
import { planReserve, computeTargetReserve } from './battery-hold-rules';

describe('planReserve', () => {
  it('floors and never prompts at or below 80', () => {
    expect(planReserve(55.7)).toEqual({ target: 55, ambiguous: false });
    expect(planReserve(80)).toEqual({ target: 80, ambiguous: false });
  });

  it('snaps 80<SoC<=85 down to 80, silently', () => {
    expect(planReserve(81)).toEqual({ target: 80, ambiguous: false });
    expect(planReserve(85)).toEqual({ target: 80, ambiguous: false });
  });

  it('prompts 80-vs-100 only in 85<SoC<95', () => {
    expect(planReserve(85.1)).toEqual({ target: 100, ambiguous: true, options: [80, 100] });
    expect(planReserve(90)).toEqual({ target: 100, ambiguous: true, options: [80, 100] });
    expect(planReserve(94.9)).toEqual({ target: 100, ambiguous: true, options: [80, 100] });
  });

  it('snaps 95<=SoC to 100, silently', () => {
    expect(planReserve(95)).toEqual({ target: 100, ambiguous: false });
    expect(planReserve(99)).toEqual({ target: 100, ambiguous: false });
    expect(planReserve(100)).toEqual({ target: 100, ambiguous: false });
  });

  it('computeTargetReserve returns just the scalar target', () => {
    expect(computeTargetReserve(55.7)).toBe(55);
    expect(computeTargetReserve(81)).toBe(80);
    expect(computeTargetReserve(90)).toBe(100);
    expect(computeTargetReserve(95)).toBe(100);
  });
});
