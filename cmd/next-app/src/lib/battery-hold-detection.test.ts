import { describe, expect, it, vi } from 'vitest';

const { detectLoadsMock } = vi.hoisted(() => ({ detectLoadsMock: vi.fn() }));
vi.mock('./nilm/load-detection', () => ({ detectLoads: detectLoadsMock }));

import { evaluateHold } from './battery-hold-detection';
import type { BatteryHold } from './db';
import type { PowerData } from './nilm/types';

const PARK = new Date('2026-05-24T18:00:00Z');

function hold(overrides: Partial<BatteryHold> = {}): BatteryHold {
  return {
    id: 1, site_id: 's', status: 'active', mode: 'auto',
    original_reserve: 20, target_reserve: 100,
    parked_soc: 90, baseline_load_w: 500,
    restore_reason: null, created_at: PARK, restored_at: null,
    safety_expires_at: new Date('2026-05-25T10:00:00Z'),
    acknowledged_at: null,
    ...overrides,
  };
}

// power samples every 5 min starting at PARK
function series(watts: number[]): PowerData[] {
  return watts.map((w, i) => ({
    timestamp: new Date(PARK.getTime() + i * 5 * 60 * 1000).toISOString(),
    powerWatts: w,
  }));
}

describe('evaluateHold', () => {
  it('restores on safety timeout regardless of load', () => {
    detectLoadsMock.mockReturnValue([]);
    const now = new Date('2026-05-25T10:00:01Z'); // past safety_expires_at
    expect(evaluateHold(hold(), series([8000, 8000]), now)).toEqual({ restore: true, reason: 'safety_timeout' });
  });

  it('restores when a closed NILM event sits near the park time', () => {
    detectLoadsMock.mockReturnValue([
      { startTime: new Date(PARK.getTime() + 5 * 60 * 1000), endTime: new Date(PARK.getTime() + 60 * 60 * 1000) },
    ]);
    const now = new Date(PARK.getTime() + 90 * 60 * 1000);
    expect(evaluateHold(hold(), series([500, 8000, 8000, 500]), now)).toEqual({ restore: true, reason: 'load_ended' });
  });

  it('keeps holding right after park before the load ramps (no false restore)', () => {
    detectLoadsMock.mockReturnValue([]); // no closed event yet
    const now = new Date(PARK.getTime() + 10 * 60 * 1000);
    // load never rose above baseline+1000 -> nothing to wait to end
    expect(evaluateHold(hold(), series([500, 480, 510]), now)).toBeNull();
  });

  it('fallback: restores when load rose then returned to baseline (no closed event)', () => {
    detectLoadsMock.mockReturnValue([]); // NILM missed the rising edge
    // 8 samples at +0..+35 min: high early, back near baseline for the last ~15 min.
    // baseline 500, tol = max(400, 100) = 400, so <=900 counts as "returned".
    const data = series([500, 8000, 8000, 8000, 550, 520, 510, 505]);
    const now = new Date(PARK.getTime() + 35 * 60 * 1000); // == last sample timestamp
    expect(evaluateHold(hold(), data, now)).toEqual({ restore: true, reason: 'load_ended' });
  });

  it('keeps holding while the load is still elevated', () => {
    detectLoadsMock.mockReturnValue([]);
    const data = series([500, 8000, 8000, 8000]); // +0..+15 min, last sample still high
    const now = new Date(PARK.getTime() + 15 * 60 * 1000);
    expect(evaluateHold(hold(), data, now)).toBeNull();
  });

  it('timer mode restores exactly at safety_expires_at and never runs NILM', () => {
    detectLoadsMock.mockReset();
    const h = hold({ mode: 'timer', safety_expires_at: new Date(PARK.getTime() + 4 * 60 * 60 * 1000) });
    const now = new Date(PARK.getTime() + 4 * 60 * 60 * 1000); // == expiry
    expect(evaluateHold(h, series([8000, 8000]), now)).toEqual({ restore: true, reason: 'timer_elapsed' });
    expect(detectLoadsMock).not.toHaveBeenCalled();
  });

  it('timer mode keeps holding before expiry regardless of load', () => {
    detectLoadsMock.mockReset();
    const h = hold({ mode: 'timer', safety_expires_at: new Date(PARK.getTime() + 4 * 60 * 60 * 1000) });
    const now = new Date(PARK.getTime() + 60 * 60 * 1000); // 1h in
    expect(evaluateHold(h, series([500, 500]), now)).toBeNull();
    expect(detectLoadsMock).not.toHaveBeenCalled();
  });
});
