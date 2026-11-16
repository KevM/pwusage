import { UTILITY_ALIASES } from './utility-aliases';
export function normalizeUtilityName(name: string): string {
  return name.toLowerCase().trim().replace(/&/g, ' and ').replace(/[.,]/g, '').replace(/\s+/g, ' ').replace(/\s+(?:co|inc|company)$/, '').trim();
}
export function resolveUtility(siteUtility: string | null, names: string[]): string | null {
  if (!siteUtility) return null;
  const key = normalizeUtilityName(siteUtility);
  const exact = names.find(name => normalizeUtilityName(name) === key);
  if (exact) return exact;
  const alias = UTILITY_ALIASES[key];
  return alias && names.includes(alias) ? alias : null;
}
export function searchUtilities(q: string, names: string[], limit = 20): string[] {
  const query = normalizeUtilityName(q);
  if (!query) return [];
  const tokens = query.split(' ');
  return names.filter(name => {
    const words = normalizeUtilityName(name).split(' ');
    return tokens.every(token => words.some(word => word.startsWith(token)));
  }).sort((a, b) => Number(normalizeUtilityName(b) === query) - Number(normalizeUtilityName(a) === query) || a.localeCompare(b)).slice(0, limit);
}
