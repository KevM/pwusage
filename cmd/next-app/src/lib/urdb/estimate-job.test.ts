import { describe, expect, it, vi } from 'vitest';
import { ownerPlanMatchesUtility, runUrdbEstimatesCron } from './estimate-job';
import type { UrdbRate } from './types';
import effective from './__fixtures__/we-energies-effective-2026-04-28.json';
import chain from './__fixtures__/we-energies-option-a-chain.json';

it('disables the cron without an OpenEI API key', async () => {
  vi.stubEnv('OPENEI_API_KEY', '');
  await expect(runUrdbEstimatesCron({ maxTimeMs: 1000, maxSites: 5 })).resolves.toMatchObject({ checked: 0, stopped: 'disabled' });
  vi.unstubAllEnvs();
});

describe('ownerPlanMatchesUtility', () => {
  const picked = chain[0] as unknown as UrdbRate;
  const inEffect = effective as unknown as UrdbRate[];

  it('accepts a plan URDB files under the canonical name of the stored alias', () => {
    // URDB lists "We energies" as a utility but files its rates under "Wisconsin Electric Power Co".
    expect(picked.utility).toBe('Wisconsin Electric Power Co');
    expect(ownerPlanMatchesUtility(picked, 'We energies', inEffect)).toBe(true);
  });

  it('accepts a plan whose utility matches the stored name loosely', () => {
    expect(ownerPlanMatchesUtility(picked, 'Wisconsin Electric Power Company', [])).toBe(true);
  });

  it('rejects a plan from another utility or a missing plan', () => {
    expect(ownerPlanMatchesUtility({ ...picked, utility: 'Pacific Gas & Electric Co' }, 'We energies', inEffect)).toBe(false);
    expect(ownerPlanMatchesUtility(picked, 'We energies', [])).toBe(false);
    expect(ownerPlanMatchesUtility(null, 'We energies', inEffect)).toBe(false);
  });
});
