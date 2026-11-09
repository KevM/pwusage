import { describe, expect, it } from 'vitest';
import { commandsDeniedText, holdButtonLabel, holdCardView, holdReserveText, guardNoticeText } from './battery-hold-format';

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

describe('holdCardView', () => {
  const base = { needsReauth: false, commandsDenied: false, hasHold: false, hasTariff: true, soc: 70 as number | null };

  it('keeps the start controls available beside the denial warning so the user can retry', () => {
    expect(holdCardView({ ...base, commandsDenied: true })).toEqual({ warning: 'commands_denied', controls: 'start' });
  });

  it('keeps the turn-off controls available beside the denial warning while a hold is active', () => {
    expect(holdCardView({ ...base, commandsDenied: true, hasHold: true })).toEqual({ warning: 'commands_denied', controls: 'active' });
  });

  it('replaces the controls with the reconnect prompt when Tesla needs re-authorization', () => {
    expect(holdCardView({ ...base, needsReauth: true, commandsDenied: true })).toEqual({ warning: 'needs_reauth', controls: 'none' });
  });

  it('picks the controls from the hold, rate plan and charge reading when nothing is wrong', () => {
    expect(holdCardView({ ...base, hasHold: true }).controls).toBe('active');
    expect(holdCardView({ ...base, hasTariff: false }).controls).toBe('no_tariff');
    expect(holdCardView({ ...base, soc: null }).controls).toBe('no_soc');
    expect(holdCardView(base)).toEqual({ warning: null, controls: 'start' });
  });
});
