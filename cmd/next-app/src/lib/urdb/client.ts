import { ioSignal } from '../io-deadline';
import type { UrdbRate } from './types';

export class UrdbUnavailableError extends Error {}
const BASE = 'https://api.openei.org/utility_rates';
const PAGE_SIZE = 500;
let utilityCache: { names: string[]; expires: number } | null = null;
function apiKey(): string {
  const key = process.env.OPENEI_API_KEY;
  if (!key) throw new UrdbUnavailableError('OpenEI API key is unavailable');
  return key;
}
async function json<T>(url: URL, cache = false): Promise<T> {
  try {
    const parent = ioSignal();
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(url, { signal: parent ? AbortSignal.any([parent, timeout]) : timeout, ...(cache ? { next: { revalidate: 604800 } } : {}) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as T;
  } catch (error) {
    throw new UrdbUnavailableError('OpenEI request failed', { cause: error });
  }
}
function localNoon(date: string, timeZone: string): number {
  const nominal = Date.parse(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nominal));
  const p = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.floor((nominal - (rendered - nominal)) / 1000);
}
async function rates(params: Record<string, string>): Promise<UrdbRate[]> {
  const key = apiKey();
  const results: UrdbRate[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < 50_000; offset += PAGE_SIZE) {
    const url = new URL(BASE);
    for (const [k, v] of Object.entries({ version: 'latest', format: 'json', sector: 'Residential', api_key: key, limit: String(PAGE_SIZE), offset: String(offset), ...params })) url.searchParams.set(k, v);
    const page = await json<{ items?: Array<UrdbRate & { supercedes?: string }>; results?: Array<UrdbRate & { supercedes?: string }> }>(url);
    const items = page.items ?? page.results ?? [];
    let added = 0;
    for (const item of items) {
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      results.push({ ...item, supersedes: item.supersedes ?? item.supercedes });
      added++;
    }
    if (items.length < PAGE_SIZE || added === 0) break;
  }
  return results;
}
export function ratesEffectiveOn(utility: string, date: string, timeZone: string): Promise<UrdbRate[]> {
  return rates({ ratesforutility: utility, detail: 'full', effective_on_date: String(localNoon(date, timeZone)) });
}
export async function rateByLabel(label: string): Promise<UrdbRate | null> {
  return (await rates({ getpage: label, detail: 'full' }))[0] ?? null;
}
export function defaultRates(utility: string): Promise<UrdbRate[]> {
  return rates({ ratesforutility: utility, detail: 'full', is_default: 'true' });
}
export async function utilityNames(): Promise<string[]> {
  apiKey();
  if (utilityCache && utilityCache.expires > Date.now()) return utilityCache.names;
  const names: string[] = [];
  const seen = new Set<string>();
  let continuation: Record<string, string> = {};
  for (let page = 0; page < 100; page++) {
    const url = new URL('https://openei.org/w/api.php');
    for (const [key, value] of Object.entries({ action: 'query', list: 'categorymembers', cmprop: 'title', cmnamespace: '0', cmlimit: 'max', format: 'json', cmtitle: 'Category:EIA Utility Companies and Aliases', ...continuation })) url.searchParams.set(key, value);
    const result = await json<{ query?: { categorymembers?: Array<{ title: string }> }; continue?: Record<string, string> }>(url, true);
    for (const item of result.query?.categorymembers ?? []) if (!seen.has(item.title)) { seen.add(item.title); names.push(item.title); }
    if (!result.continue) { utilityCache = { names, expires: Date.now() + 604800_000 }; return names; }
    if (JSON.stringify(result.continue) === JSON.stringify(continuation)) throw new UrdbUnavailableError('OpenEI utility continuation repeated');
    continuation = result.continue;
  }
  throw new UrdbUnavailableError('OpenEI utility directory exceeded page limit');
}
