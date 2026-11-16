import { expect, it, vi } from 'vitest';
import { runUrdbEstimatesCron } from './estimate-job';
it('disables the cron without an OpenEI API key', async () => {
  vi.stubEnv('OPENEI_API_KEY', '');
  await expect(runUrdbEstimatesCron({ maxTimeMs: 1000, maxSites: 5 })).resolves.toMatchObject({ checked: 0, stopped: 'disabled' });
  vi.unstubAllEnvs();
});
