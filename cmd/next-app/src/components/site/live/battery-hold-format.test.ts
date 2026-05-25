import { describe, expect, it } from 'vitest';
import { holdButtonLabel, holdReserveText, guardNoticeText } from './battery-hold-format';

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

describe('holdReserveText', () => {
  it('labels 100 as max and others as a plain percent', () => {
    expect(holdReserveText(100)).toBe('100% (max)');
    expect(holdReserveText(80)).toBe('80%');
    expect(holdReserveText(67)).toBe('67%');
  });
});

describe('guardNoticeText', () => {
  it('explains the hold was cancelled and the reserve left as-is', () => {
    expect(guardNoticeText(50)).toBe('Hold cancelled — your reserve is set to 50% (changed outside the app), so we left it as-is.');
  });
});
