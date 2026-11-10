import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeslaClient, type StoredTeslaCredentials } from './tesla-client';

const start = new Date('2026-11-08T06:00:00Z');
const end = new Date('2026-11-09T06:00:00Z');
const answer = { response: { time_series: [], backup_reserve_percent: 20, Code: 200 } };

describe('Tesla site ID translation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the pinned account’s mapped ID for every site endpoint', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(answer));
    const beforeRequest = vi.fn(async (): Promise<StoredTeslaCredentials> => ({
      access_token: 'account-a-token', refresh_token: 'account-a-refresh',
      tesla_energy_site_id: 'account-a-tesla-id',
    }));
    const client = new TeslaClient({ accessToken: 'account-a-token', beforeRequest, requireTeslaSiteMapping: true });

    await client.getEnergySiteInfo('pwusage-site');
    await client.getEnergyHistory('pwusage-site', start, end, 'day', 'America/Chicago');
    await client.getSoeHistory('pwusage-site', start, end, 'day', 'America/Chicago');
    await client.getLiveStatus('pwusage-site');
    await client.setBackupReserve('pwusage-site', 30);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(String(url)).pathname).toContain('/energy_sites/account-a-tesla-id/');
      expect(new URL(String(url)).pathname).not.toContain('/energy_sites/pwusage-site/');
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer account-a-token' });
    }
  });

  it('uses a new mapping after re-invitation and never sends an unmapped ID', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(answer));
    let mapping: string | undefined = 'first-invite-id';
    const client = new TeslaClient({
      accessToken: 'account-a-token', requireTeslaSiteMapping: true,
      beforeRequest: async () => ({ access_token: 'account-a-token', tesla_energy_site_id: mapping }),
    });
    await client.getLiveStatus('pwusage-site');
    mapping = 'new-invite-id';
    await client.getLiveStatus('pwusage-site');
    mapping = undefined;
    await expect(client.getLiveStatus('pwusage-site')).rejects.toThrow(/mapping/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toContain('/first-invite-id/');
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toContain('/new-invite-id/');
  });
});
