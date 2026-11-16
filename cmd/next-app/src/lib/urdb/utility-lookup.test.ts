import { describe, expect, it } from 'vitest';
import { UTILITY_ALIASES } from './utility-aliases';
import { resolveUtility, searchUtilities } from './utility-lookup';
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

  it.each(['AGL', 'Amber Electric', 'Contact Energy'])('returns null for non-US utility %s', utility => {
    expect(resolveUtility(utility, names)).toBeNull();
  });

  it('ranks exact normalized matches first', () => {
    expect(searchUtilities('peco', ['PECO Energy Co', 'PECO', 'Pecos Valley Energy', 'Pacific Gas & Electric Co']))
      .toEqual(['PECO', 'PECO Energy Co', 'Pecos Valley Energy']);
  });
});
