import { describe, expect, it, vi } from 'vitest';
import { expandHistoryPeriod, HistoryPeriodError } from './history-expand';
import { memoisedApi } from './memoised-api';
import type { UrdbRate } from './types';
import type { UrdbApi } from './estimate-job';
import chain from './__fixtures__/we-energies-option-b-chain.json';
import y2025 from './__fixtures__/we-energies-effective-2025-07-01.json';
import y2024 from './__fixtures__/we-energies-effective-2024-07-01.json';

const OPTION_B = '685a177d100bd6b82a005dc0';
const UTILITY = 'Wisconsin Electric Power Co';
const chainRates = chain as unknown as UrdbRate[];
const effective: Record<string, UrdbRate[]> = { '2026-04-27': y2025 as unknown as UrdbRate[], '2025-07-01': y2025 as unknown as UrdbRate[], '2024-07-01': y2024 as unknown as UrdbRate[] };
function fake(overrides: Partial<Record<string, UrdbRate>> = {}) {
  const rateByLabel = vi.fn(async (label: string) => overrides[label] ?? [...chainRates, ...Object.values(effective).flat()].find(rate => rate.label === label) ?? null);
  // URDB lists We Energies under its alias too; both names return rates filed under UTILITY.
  const ratesEffectiveOn = vi.fn(async (utility: string, date: string) => [UTILITY, 'We energies'].includes(utility) ? effective[date] ?? [] : []);
  return { api: { ratesEffectiveOn, rateByLabel, defaultRates: vi.fn(), utilityNames: vi.fn() } as unknown as UrdbApi, rateByLabel, ratesEffectiveOn };
}
const ctx = (api: UrdbApi) => ({ api, utilityName: UTILITY, timeZone: 'America/Chicago', today: '2026-11-16', convert: { medianMonthlyKwh: null, fallbackSellRate: 0 } });
const span = (revisions: Array<{ from: string; to: string | null }>) => revisions.map(r => [r.from, r.to]);

describe('expandHistoryPeriod', () => {
  it('expandsOptionBAcrossItsRevisions', async () => {
    const { api } = fake();
    const result = await expandHistoryPeriod({ label: OPTION_B, from: '2023-11-14', to: '2026-04-27' }, ctx(api));
    expect(span(result)).toEqual([['2023-11-14', '2023-12-31'], ['2024-01-01', '2025-05-31'], ['2025-06-01', '2026-04-27']]);
    expect(result.map(r => r.revisionStart)).toEqual(['2022-01-01', '2024-01-01', '2025-06-01']);
    expect(result[2].label).toBe(OPTION_B);
    expect(result.every(r => r.seasons.length > 0 && r.name)).toBe(true);
  });
  it('findsTheNewerRevisionForTheEndDate', async () => {
    const { api } = fake();
    const result = await expandHistoryPeriod({ label: '664ba69c2b718f86d8003ffe', from: '2024-01-01', to: '2026-04-27' }, ctx(api));
    expect(result.at(-1)).toMatchObject({ label: OPTION_B, from: '2025-06-01', to: '2026-04-27' });
  });
  it('oldestRevisionExtendsBackToFrom', async () => {
    const { api } = fake();
    const result = await expandHistoryPeriod({ label: OPTION_B, from: '2010-03-05', to: '2026-04-27' }, ctx(api));
    expect(result[0]).toMatchObject({ from: '2010-03-05', revisionStart: '2014-01-01' });
    expect(result[0].to).toBe('2014-12-31');
  });
  it('openEndedPeriodRunsToNull', async () => {
    const { api } = fake();
    const result = await expandHistoryPeriod({ label: OPTION_B, from: '2025-06-01', to: null }, ctx(api));
    expect(result).toHaveLength(1);
    expect(result[0].to).toBeNull();
  });
  it('unconvertibleRevisionTakesNewerPrices', async () => {
    const base = chainRates.find(rate => rate.label === '664ba69c2b718f86d8003ffe')!;
    const { api } = fake({ '664ba69c2b718f86d8003ffe': { ...base, energyweekdayschedule: undefined } });
    const result = await expandHistoryPeriod({ label: OPTION_B, from: '2024-01-01', to: '2026-04-27' }, ctx(api));
    expect(result).toHaveLength(2);
    expect(result[0].seasons).toEqual(result[1].seasons);
    expect(result[0].label).toBe('664ba69c2b718f86d8003ffe');
  });
  it('rejectsAnotherUtilitysLabel', async () => {
    const { api } = fake();
    await expect(expandHistoryPeriod({ label: OPTION_B, from: '2024-01-01', to: null }, { ...ctx(api), utilityName: 'Other Power' })).rejects.toThrow('That rate plan isn’t listed for your utility.');
    await expect(expandHistoryPeriod({ label: 'nope', from: '2024-01-01', to: null }, ctx(api))).rejects.toBeInstanceOf(HistoryPeriodError);
  });
  it('acceptsPlansFiledUnderTheUtilitysUrdbAlias', async () => {
    const { api } = fake();
    const result = await expandHistoryPeriod({ label: OPTION_B, from: '2023-11-14', to: '2026-04-27' }, { ...ctx(api), utilityName: 'We energies' });
    expect(result.at(-1)?.label).toBe(OPTION_B);
  });
  it('rejectsPeriodWithNoConvertibleRevision', async () => {
    const broken = Object.fromEntries(chainRates.map(rate => [rate.label, { ...rate, energyweekdayschedule: undefined }]));
    const { api } = fake(broken);
    await expect(expandHistoryPeriod({ label: OPTION_B, from: '2024-01-01', to: '2024-06-01' }, ctx(api))).rejects.toThrow('We couldn’t read the rates for Residential Time-of-Use (Single-Phase, Option B) Rg 2. Add this rate plan in Rate Plans.');
  });
  it('memoisesLabelFetches', async () => {
    const { api, rateByLabel } = fake();
    const memo = memoisedApi(api);
    await expandHistoryPeriod({ label: OPTION_B, from: '2023-11-14', to: '2026-04-27' }, ctx(memo));
    await expandHistoryPeriod({ label: OPTION_B, from: '2018-01-01', to: '2023-11-13' }, ctx(memo));
    const labels = rateByLabel.mock.calls.map(call => call[0]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
