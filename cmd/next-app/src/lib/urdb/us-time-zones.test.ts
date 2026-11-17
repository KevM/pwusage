import { describe, expect, it } from 'vitest';
import { isOutsideUs } from './us-time-zones';

describe('isOutsideUs', () => {
  it('flags zones outside the US', () => {
    for (const zone of ['Australia/Sydney', 'Australia/Adelaide', 'Pacific/Auckland', 'America/Edmonton', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'Europe/London', 'Asia/Tokyo', 'Canada/Mountain']) {
      expect(isOutsideUs(zone), zone).toBe(true);
    }
  });

  it('keeps US states, territories and their legacy names', () => {
    for (const zone of ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Los_Angeles', 'America/Detroit', 'America/Anchorage', 'America/Indiana/Indianapolis', 'America/Fort_Wayne', 'Pacific/Honolulu', 'America/Puerto_Rico', 'Pacific/Guam', 'US/Eastern', 'US/Pacific']) {
      expect(isOutsideUs(zone), zone).toBe(false);
    }
  });

  it('does not guess for zones with no location', () => {
    for (const zone of [null, undefined, '', 'UTC', 'GMT', 'Etc/UTC', 'Navajo']) {
      expect(isOutsideUs(zone), String(zone)).toBe(false);
    }
  });
});
