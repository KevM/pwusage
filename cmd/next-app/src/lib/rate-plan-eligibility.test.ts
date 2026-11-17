import { describe, expect, it } from 'vitest';
import {
  deriveRatePlanEligibility,
  normalizeRateCountryCode,
  shouldApplyRateCountryWrite,
  validateSiteRateCountryInput,
} from './rate-plan-eligibility';
import { TariffValidationError } from './tariff-timeline';

describe('rate-plan-eligibility', () => {
  describe('deriveRatePlanEligibility', () => {
    it('treats US and US territories as eligible', () => {
      for (const code of ['US', 'us', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM']) {
        expect(deriveRatePlanEligibility(code)).toBe('us');
      }
    });

    it('treats other valid ISO-3166-1 alpha-2 countries as outside_us', () => {
      for (const code of ['CA', 'GB', 'AU', 'NZ', 'DE', 'JP', 'EC', 'MX']) {
        expect(deriveRatePlanEligibility(code)).toBe('outside_us');
      }
    });

    it('treats null, undefined, and empty values as unknown without defaulting to US', () => {
      for (const code of [null, undefined, '', '   ']) {
        expect(deriveRatePlanEligibility(code)).toBe('unknown');
      }
    });
  });

  describe('normalizeRateCountryCode', () => {
    it('normalizes valid ISO-3166-1 alpha-2 codes and preserves null', () => {
      expect(normalizeRateCountryCode(null)).toBeNull();
      expect(normalizeRateCountryCode('us')).toBe('US');
      expect(normalizeRateCountryCode(' ca ')).toBe('CA');
      expect(normalizeRateCountryCode('GB')).toBe('GB');
      expect(normalizeRateCountryCode('pr')).toBe('PR');
    });

    it('rejects invalid codes, aliases, and non-strings', () => {
      for (const bad of ['', '   ', 'U', 'USA', 'UK', 'EU', 'UN', 'XX', 'ZZ', 'AA', '12', 'U1', 123, true, {}]) {
        expect(() => normalizeRateCountryCode(bad)).toThrow(TariffValidationError);
      }
    });
  });

  describe('validateSiteRateCountryInput', () => {
    it('accepts valid countryCode + source payloads including null clears', () => {
      expect(validateSiteRateCountryInput({ countryCode: 'us', source: 'solar_location' })).toEqual({
        countryCode: 'US',
        source: 'solar_location',
      });
      expect(validateSiteRateCountryInput({ countryCode: null, source: 'solar_location' })).toEqual({
        countryCode: null,
        source: 'solar_location',
      });
      expect(validateSiteRateCountryInput({ countryCode: 'ca', source: 'owner' })).toEqual({
        countryCode: 'CA',
        source: 'owner',
      });
      expect(validateSiteRateCountryInput({ countryCode: null, source: 'owner' })).toEqual({
        countryCode: null,
        source: 'owner',
      });
    });

    it('rejects payloads containing coordinates or location details anywhere', () => {
      const payloadsWithCoords = [
        { countryCode: 'US', source: 'solar_location', lat: 43.07, lng: -89.4 },
        { countryCode: 'US', source: 'solar_location', latitude: 43.07, longitude: -89.4 },
        { countryCode: 'US', source: 'owner', lon: -89.4 },
        { countryCode: 'US', source: 'owner', coordinates: { lat: 43.07, lng: -89.4 } },
        { countryCode: 'US', source: 'solar_location', location: '43.07,-89.4' },
        { countryCode: 'US', source: 'solar_location', panels: [] },
      ];
      for (const payload of payloadsWithCoords) {
        expect(() => validateSiteRateCountryInput(payload)).toThrow(/coordinates/i);
      }
    });

    it('rejects invalid sources, missing fields, and unknown extra keys', () => {
      for (const bad of [
        null,
        [],
        'US',
        {},
        { countryCode: 'US' },
        { source: 'owner' },
        { countryCode: 'US', source: 'timezone' },
        { countryCode: 'US', source: 'tesla' },
        { countryCode: 'US', source: 'owner', extra: 'nope' },
      ]) {
        expect(() => validateSiteRateCountryInput(bad)).toThrow(TariffValidationError);
      }
    });
  });

  describe('shouldApplyRateCountryWrite', () => {
    it('lets solar_location populate unknown and update or clear stale inference', () => {
      expect(
        shouldApplyRateCountryWrite({ countryCode: null, source: null }, { countryCode: 'US', source: 'solar_location' })
      ).toEqual({ apply: true, nextCountryCode: 'US', nextSource: 'solar_location' });

      expect(
        shouldApplyRateCountryWrite({ countryCode: 'US', source: 'solar_location' }, { countryCode: 'CA', source: 'solar_location' })
      ).toEqual({ apply: true, nextCountryCode: 'CA', nextSource: 'solar_location' });

      expect(
        shouldApplyRateCountryWrite({ countryCode: 'US', source: 'solar_location' }, { countryCode: null, source: 'solar_location' })
      ).toEqual({ apply: true, nextCountryCode: null, nextSource: null });
    });

    it('enforces explicit owner precedence over solar_location inference and clearing', () => {
      expect(
        shouldApplyRateCountryWrite({ countryCode: 'US', source: 'owner' }, { countryCode: 'CA', source: 'solar_location' })
      ).toEqual({ apply: false, nextCountryCode: 'US', nextSource: 'owner' });

      expect(
        shouldApplyRateCountryWrite({ countryCode: 'US', source: 'owner' }, { countryCode: null, source: 'solar_location' })
      ).toEqual({ apply: false, nextCountryCode: 'US', nextSource: 'owner' });

      expect(
        shouldApplyRateCountryWrite({ countryCode: 'CA', source: 'solar_location' }, { countryCode: 'US', source: 'owner' })
      ).toEqual({ apply: true, nextCountryCode: 'US', nextSource: 'owner' });

      expect(
        shouldApplyRateCountryWrite({ countryCode: 'US', source: 'solar_location' }, { countryCode: 'US', source: 'owner' })
      ).toEqual({ apply: true, nextCountryCode: 'US', nextSource: 'owner' });

      expect(
        shouldApplyRateCountryWrite({ countryCode: 'US', source: 'owner' }, { countryCode: null, source: 'owner' })
      ).toEqual({ apply: true, nextCountryCode: null, nextSource: null });
    });

    it('treats identical country + source writes as no-ops', () => {
      expect(
        shouldApplyRateCountryWrite({ countryCode: 'US', source: 'solar_location' }, { countryCode: 'US', source: 'solar_location' })
      ).toEqual({ apply: false, nextCountryCode: 'US', nextSource: 'solar_location' });

      expect(
        shouldApplyRateCountryWrite({ countryCode: null, source: null }, { countryCode: null, source: 'solar_location' })
      ).toEqual({ apply: false, nextCountryCode: null, nextSource: null });
    });
  });
});
