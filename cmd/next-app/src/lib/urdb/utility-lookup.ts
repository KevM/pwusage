import { UTILITY_ALIASES, WIRES_ONLY_UTILITIES } from './utility-aliases';
export function normalizeUtilityName(name: string): string {
  return name.toLowerCase().trim().replace(/&/g, ' and ').replace(/[.,]/g, '').replace(/\s+/g, ' ').replace(/\s+(?:co|inc|company)$/, '').trim();
}
function resolveName(siteUtility: string | null | undefined, names: string[]): string | null {
  if (!siteUtility) return null;
  const key = normalizeUtilityName(siteUtility);
  if (!key) return null;
  const exact = names.find(name => normalizeUtilityName(name) === key);
  if (exact) return exact;
  const alias = UTILITY_ALIASES[key];
  return alias && names.includes(alias) ? alias : null;
}
// The rate plan's utility comes first. Tesla's grid utility is the fallback: it often names the
// distribution utility when the plan carries a short name ("Duke"), a CCA or nothing at all.
export function resolveUtility(siteUtility: string | null, names: string[], gridUtility?: string | null): string | null {
  const fromPlan = resolveName(siteUtility, names);
  if (fromPlan) return fromPlan;
  if (!gridUtility || WIRES_ONLY_UTILITIES.has(normalizeUtilityName(gridUtility))) return null;
  return resolveName(gridUtility, names);
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
