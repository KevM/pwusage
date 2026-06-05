import { describe, expect, it } from 'vitest';
import { safeInternalPath, isIOSUserAgent, continueUrl } from './continue-logic';

describe('safeInternalPath', () => {
  it('passes through a normal internal path with query', () => {
    expect(safeInternalPath('/site/1/live?action=park')).toBe('/site/1/live?action=park');
  });

  it('rejects protocol-relative and absolute URLs (open-redirect guard)', () => {
    expect(safeInternalPath('//evil.com')).toBe('/');
    expect(safeInternalPath('https://evil.com')).toBe('/');
    expect(safeInternalPath('/\\evil.com')).toBe('/');
  });

  it('defaults to / for missing/blank input', () => {
    expect(safeInternalPath(undefined)).toBe('/');
    expect(safeInternalPath(null)).toBe('/');
    expect(safeInternalPath('')).toBe('/');
  });
});

describe('isIOSUserAgent', () => {
  it('detects iPhone/iPad/iPod', () => {
    expect(isIOSUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1')).toBe(true);
    expect(isIOSUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(true);
  });

  it('is false for desktop / Android / empty', () => {
    expect(isIOSUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15')).toBe(false);
    expect(isIOSUserAgent('Mozilla/5.0 (Linux; Android 14)')).toBe(false);
    expect(isIOSUserAgent(null)).toBe(false);
    expect(isIOSUserAgent(undefined)).toBe(false);
  });
});

describe('continueUrl', () => {
  it('builds an absolute /continue URL with the target encoded in `to`', () => {
    expect(continueUrl('https://pwusage.fm.rodeo', '/site/1/live?action=park'))
      .toBe('https://pwusage.fm.rodeo/continue?to=%2Fsite%2F1%2Flive%3Faction%3Dpark');
  });

  it('encodes a TRMNL manage path with its query', () => {
    expect(continueUrl('https://pwusage.fm.rodeo', '/trmnl/manage?uuid=abc-123'))
      .toBe('https://pwusage.fm.rodeo/continue?to=%2Ftrmnl%2Fmanage%3Fuuid%3Dabc-123');
  });
});
