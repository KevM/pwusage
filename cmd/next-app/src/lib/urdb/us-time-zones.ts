// OpenEI's rate database lists US utilities only. Sites store no country, so the IANA time zone is the
// only location signal: a zone that is certainly outside the US means no OpenEI utility can match.
// Unknown or location-free zones (UTC, Etc/*, missing) are not treated as outside the US.

// US zones under America/, US territories included (from tzdata zone.tab, with backward links).
const US_AMERICA = new Set([
  'America/Adak', 'America/Anchorage', 'America/Atka', 'America/Boise', 'America/Chicago', 'America/Denver',
  'America/Detroit', 'America/Fort_Wayne', 'America/Indiana/Indianapolis', 'America/Indiana/Knox',
  'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Tell_City', 'America/Indiana/Vevay',
  'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Indianapolis', 'America/Juneau',
  'America/Kentucky/Louisville', 'America/Kentucky/Monticello', 'America/Knox_IN', 'America/Los_Angeles',
  'America/Louisville', 'America/Menominee', 'America/Metlakatla', 'America/New_York', 'America/Nome',
  'America/North_Dakota/Beulah', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/Phoenix',
  'America/Puerto_Rico', 'America/Shiprock', 'America/Sitka', 'America/St_Thomas', 'America/Virgin', 'America/Yakutat',
]);
// US zones under Pacific/ (Hawaii and the territories).
const US_PACIFIC = new Set([
  'Pacific/Guam', 'Pacific/Honolulu', 'Pacific/Johnston', 'Pacific/Midway', 'Pacific/Pago_Pago', 'Pacific/Saipan',
  'Pacific/Samoa', 'Pacific/Wake',
]);
// Regions with no US zones at all.
const NON_US_REGIONS = new Set([
  'Africa', 'Antarctica', 'Arctic', 'Asia', 'Atlantic', 'Australia', 'Brazil', 'Canada', 'Chile', 'Europe', 'Indian',
  'Mexico',
]);

export function isOutsideUs(timeZone: string | null | undefined): boolean {
  if (!timeZone) return false;
  const region = timeZone.split('/')[0];
  if (region === timeZone) return false;
  if (region === 'America') return !US_AMERICA.has(timeZone);
  if (region === 'Pacific') return !US_PACIFIC.has(timeZone);
  return NON_US_REGIONS.has(region);
}
