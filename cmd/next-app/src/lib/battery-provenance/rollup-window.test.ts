import { describe, it, expect } from 'vitest';
import { isInRollupBand, localHourFor } from './rollup-window';

describe('rollup window selection', () => {
  it('localHourFor returns the wall-clock hour in the given zone', () => {
    // 2026-01-02T10:00:00Z is 02:00 in America/Los_Angeles (UTC-8)
    expect(localHourFor(new Date('2026-01-02T10:00:00Z'), 'America/Los_Angeles')).toBe(2);
  });
  it('isInRollupBand true for local hours 2..5, false otherwise', () => {
    const tz = 'UTC';
    expect(isInRollupBand(new Date('2026-01-02T02:30:00Z'), tz)).toBe(true);
    expect(isInRollupBand(new Date('2026-01-02T05:00:00Z'), tz)).toBe(true);
    expect(isInRollupBand(new Date('2026-01-02T06:00:00Z'), tz)).toBe(false);
    expect(isInRollupBand(new Date('2026-01-02T01:00:00Z'), tz)).toBe(false);
  });
  it('half-hour zones still land in the band', () => {
    // 21:00Z is 02:30 in Asia/Kolkata (UTC+5:30)
    expect(isInRollupBand(new Date('2026-01-02T21:00:00Z'), 'Asia/Kolkata')).toBe(true);
  });
});
