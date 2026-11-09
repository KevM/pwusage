import { describe, expect, it } from 'vitest';
import { commandsDeniedText, holdButtonLabel, holdReserveText, guardNoticeText } from './battery-hold-format';

describe('holdButtonLabel', () => {
  it('shows the floored charge level at or below 80', () => {
    expect(holdButtonLabel(55.7)).toBe('Turn On Battery Saver at 55%');
    expect(holdButtonLabel(80)).toBe('Turn On Battery Saver at 80%');
  });
  it('shows 100% (max) above 80, unless ambiguous', () => {
    expect(holdButtonLabel(90)).toBe('Turn On Battery Saver…');
    expect(holdButtonLabel(100)).toBe('Turn On Battery Saver at 100% (max)');
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
  it('explains Battery Saver stopped and the reserve was left as-is', () => {
    expect(guardNoticeText(50)).toBe('Battery Saver stopped. Your reserve was changed outside pwusage to 50%, so we left it as-is.');
  });
});

describe('commandsDeniedText', () => {
  it('explains a Tesla command denial without asking the member to reconnect', () => {
    expect(commandsDeniedText()).toBe('Tesla did not allow this account to change the backup reserve. Check Powerwall access in Tesla’s app, then try again.');
  });
});
