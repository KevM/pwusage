import type { RateCountrySource, RatePlanEligibility } from './db-types';
import { TariffValidationError } from './tariff-timeline';

export type { RateCountrySource, RatePlanEligibility };

/**
 * Officially assigned ISO 3166-1 alpha-2 country/territory codes (249 entries).
 * Non-ISO aliases/reserved placeholders such as UK, EU, UN, XX, ZZ, AA are rejected.
 */
export const ISO_3166_1_ALPHA_2_CODES: ReadonlySet<string> = new Set([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW',
  'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT',
  'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS',
  'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
]);

/**
 * ISO 3166-1 alpha-2 codes covered by the US EIA / OpenEI Utility Rate Database
 * (the 50 states + DC under US, plus US territories represented in OpenEI).
 */
export const US_ELIGIBLE_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'US',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
  'UM',
]);

export const US_ELIGIBLE_COUNTRY_LIST: readonly string[] = [...US_ELIGIBLE_COUNTRY_CODES];

const COORDINATE_OR_LOCATION_KEYS = new Set([
  'lat',
  'lng',
  'lon',
  'long',
  'latitude',
  'longitude',
  'coord',
  'coords',
  'coordinate',
  'coordinates',
  'location',
  'geopoint',
  'position',
  'solarlayout',
  'solar_layout',
  'panels',
  'tilt',
  'azimuth',
]);

const ALLOWED_RATE_COUNTRY_KEYS = new Set(['countryCode', 'source']);

export class UtilityChangedError extends Error {
  readonly status = 409;
}

export class PublicPlansIneligibleError extends UtilityChangedError {
  readonly code = 'PUBLIC_PLANS_UNAVAILABLE' as const;
  readonly eligibility: Exclude<RatePlanEligibility, 'us'>;

  constructor(eligibility: Exclude<RatePlanEligibility, 'us'>) {
    super(
      eligibility === 'unknown'
        ? 'Confirm your site country before using public utility rate plans.'
        : 'Public utility rate plans are currently available for US sites.'
    );
    this.eligibility = eligibility;
  }
}

export interface ValidatedSiteRateCountryInput {
  countryCode: string | null;
  source: RateCountrySource;
}

export interface SiteRateCountryRecord {
  countryCode: string | null;
  source: RateCountrySource | null;
}

export interface RateCountryWriteDecision {
  apply: boolean;
  nextCountryCode: string | null;
  nextSource: RateCountrySource | null;
}

function containsCoordinateOrLocationKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(item => containsCoordinateOrLocationKey(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (COORDINATE_OR_LOCATION_KEYS.has(key.toLowerCase())) {
      return true;
    }
    if (containsCoordinateOrLocationKey(obj[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates and normalizes an ISO 3166-1 alpha-2 country code (or explicit `null` to clear).
 * Never echoes raw input values or falls back on invalid/empty values.
 */
export function normalizeRateCountryCode(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new TariffValidationError('Choose a valid two-letter country code.');
  }
  const normalized = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || !ISO_3166_1_ALPHA_2_CODES.has(normalized)) {
    throw new TariffValidationError('Choose a valid two-letter country code.');
  }
  return normalized;
}

/**
 * Validates `PUT /api/site/[id]/rate-country` payloads strictly.
 * Rejects any coordinates, location hints, or unexpected keys without logging them.
 */
export function validateSiteRateCountryInput(raw: unknown): ValidatedSiteRateCountryInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TariffValidationError('Invalid request body.');
  }
  if (containsCoordinateOrLocationKey(raw)) {
    throw new TariffValidationError(
      'Site coordinates and location details are not accepted; send only countryCode and source.'
    );
  }
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== ALLOWED_RATE_COUNTRY_KEYS.size ||
    !keys.every(key => ALLOWED_RATE_COUNTRY_KEYS.has(key)) ||
    !('countryCode' in input) ||
    !('source' in input)
  ) {
    throw new TariffValidationError('Invalid request body.');
  }

  const source = input.source;
  if (source !== 'solar_location' && source !== 'owner') {
    throw new TariffValidationError('Choose a valid country source.');
  }

  return {
    countryCode: normalizeRateCountryCode(input.countryCode),
    source,
  };
}

/**
 * Derives OpenEI/URDB public rate-plan eligibility solely from a stored site country code.
 * Never infers eligibility from timezone, currency, phone location, or Tesla API region.
 */
export function deriveRatePlanEligibility(countryCode: string | null | undefined): RatePlanEligibility {
  if (typeof countryCode !== 'string') {
    return 'unknown';
  }
  const normalized = countryCode.trim().toUpperCase();
  if (!normalized || !ISO_3166_1_ALPHA_2_CODES.has(normalized)) {
    return 'unknown';
  }
  return US_ELIGIBLE_COUNTRY_CODES.has(normalized) ? 'us' : 'outside_us';
}

export interface SiteEligibilityContext {
  eligibility?: RatePlanEligibility;
  rateCountry?: string | null;
}

export function resolveSiteRatePlanEligibility(site: SiteEligibilityContext): RatePlanEligibility {
  return site.eligibility ?? deriveRatePlanEligibility(site.rateCountry ?? null);
}

export function assertUsRatePlanEligibility(eligibility: RatePlanEligibility): void {
  if (eligibility !== 'us') {
    throw new PublicPlansIneligibleError(eligibility);
  }
}

export function assertSiteContextUsEligible(site: SiteEligibilityContext): void {
  assertUsRatePlanEligibility(resolveSiteRatePlanEligibility(site));
}

export function publicPlansIneligiblePayload(error: PublicPlansIneligibleError): {
  error: string;
  code: 'PUBLIC_PLANS_UNAVAILABLE';
  eligibility: Exclude<RatePlanEligibility, 'us'>;
} {
  return {
    error: error.message,
    code: error.code,
    eligibility: error.eligibility,
  };
}

/**
 * Enforces provenance precedence for site rate country updates:
 * - An explicit `'owner'` choice wins over `'solar_location'` inference (including clearing).
 * - `'solar_location'` may set, update, or clear (`null`) an unowned or prior inferred value.
 */
export function shouldApplyRateCountryWrite(
  current: SiteRateCountryRecord,
  next: ValidatedSiteRateCountryInput
): RateCountryWriteDecision {
  if (next.source === 'solar_location' && current.source === 'owner') {
    return {
      apply: false,
      nextCountryCode: current.countryCode,
      nextSource: current.source,
    };
  }

  const nextCountryCode = next.countryCode;
  const nextSource: RateCountrySource | null = nextCountryCode === null ? null : next.source;
  const changed = current.countryCode !== nextCountryCode || current.source !== nextSource;
  return {
    apply: changed,
    nextCountryCode,
    nextSource,
  };
}
