import { describe, expect, it } from 'vitest';
import { UTILITY_ALIASES, WIRES_ONLY_UTILITIES } from './utility-aliases';
import { normalizeUtilityName, resolveUtility, searchUtilities } from './utility-lookup';
import names from './__fixtures__/utility-companies.json';

describe('URDB utility lookup', () => {
  it('resolves exact names case and punctuation insensitively', () => {
    expect(resolveUtility('  PECO ENERGY, INC. ', names)).toBe('PECO Energy Co');
    expect(resolveUtility('Pacific Gas and Electric Co', names)).toBe('Pacific Gas & Electric Co');
  });

  it('resolves known aliases', () => {
    expect(resolveUtility('Xcel Energy - Colorado', names)).toBe(UTILITY_ALIASES['xcel energy - colorado']);
  });

  it('keeps every alias target in the recorded utility list', () => {
    const targets = new Set(names);
    expect(Object.values(UTILITY_ALIASES).filter((target: string) => !targets.has(target))).toEqual([]);
  });

  it('keeps every alias and wires-only key in normalized form so lookups can reach it', () => {
    const keys = [...Object.keys(UTILITY_ALIASES), ...WIRES_ONLY_UTILITIES];
    expect(keys.filter(key => normalizeUtilityName(key) !== key)).toEqual([]);
  });

  it.each([
    ['Eversource Energy (Formerly Connecticut Light & Power Co)', 'Eversource Energy Connecticut'],
    ['Eversource Energy (Formerly NSTAR Electric Company)', 'Eversource of Massachusetts'],
    ['Central Hudson', 'Central Hudson Gas & Elec Corp'],
    ['Denton Municipal Electric', 'City of Denton, Texas (Utility Company)'],
  ])('resolves the Tesla plan utility %s', (plan, expected) => {
    expect(resolveUtility(plan, names)).toBe(expected);
  });

  it.each([
    ['Duke', 'Duke Energy Florida, a part of Duke Energy', 'Progress Energy Florida Inc'],
    ['NVEnergy', 'NV Energy South', 'Nevada Power Co'],
    ['Clean Power SF', 'Pacific Gas and Electric Company', 'Pacific Gas & Electric Co'],
    [null, 'Green Mountain Power', 'Green Mountain Power Corp'],
    [null, 'AVANGRID (Central Maine Power)', 'Central Maine Power Co'],
    [null, 'Wisconsin Public Service Corporation', 'Wisconsin Public Service Corp'],
    [null, 'DTE Energy (DTE Energy Electric Company)', 'DTE Electric'],
  ])('falls back to the Tesla grid utility when the plan utility %s does not resolve', (plan, grid, expected) => {
    expect(resolveUtility(plan, names, grid)).toBe(expected);
  });

  it('prefers the plan utility over the grid utility', () => {
    expect(resolveUtility('PECO Energy Co', names, 'PPL Electric Utilities')).toBe('PECO Energy Co');
  });

  it.each([
    ['Budget Power', 'CenterPoint Energy'],
    ['Tesla Electric', 'CenterPoint Energy'],
    ['Tesla Electric', 'AEP Texas Central Company'],
    ['Tesla Electric', 'AEP Texas North Company'],
    ['Tesla Electric', 'Oncor Electric Delivery Company LLC'],
    ['Tesla Electric', 'Texas-New Mexico Power Co'],
    ['AGL', '*'],
    ['Alberta Cooperative Energy', 'FortisAlberta'],
    [null, null],
  ])('returns null for plan %s with grid utility %s', (plan, grid) => {
    expect(resolveUtility(plan, names, grid)).toBeNull();
  });

  it.each(['AGL', 'Amber Electric', 'Contact Energy'])('returns null for non-US utility %s', utility => {
    expect(resolveUtility(utility, names)).toBeNull();
  });

  it('ranks exact normalized matches first', () => {
    expect(searchUtilities('peco', ['PECO Energy Co', 'PECO', 'Pecos Valley Energy', 'Pacific Gas & Electric Co']))
      .toEqual(['PECO', 'PECO Energy Co', 'Pecos Valley Energy']);
  });
});
