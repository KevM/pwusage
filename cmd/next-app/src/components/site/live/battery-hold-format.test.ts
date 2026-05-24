import { describe, expect, it } from 'vitest';
import { holdButtonLabel } from './battery-hold-format';

describe('holdButtonLabel', () => {
  it('shows the floored SoC at or below 80', () => {
    expect(holdButtonLabel(55.7)).toBe('Hold battery at 55%');
    expect(holdButtonLabel(80)).toBe('Hold battery at 80%');
  });
  it('shows 100% (max) above 80', () => {
    expect(holdButtonLabel(90)).toBe('Hold battery at 100% (max)');
    expect(holdButtonLabel(100)).toBe('Hold battery at 100% (max)');
  });
});
