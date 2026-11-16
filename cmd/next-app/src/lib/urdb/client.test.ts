import { afterEach, describe, expect, it, vi } from 'vitest';
import { ratesEffectiveOn, UrdbUnavailableError } from './client';

const response = (results: unknown[], status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ results }),
}) as Response;

describe('URDB client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pages rate results until a short page', async () => {
    vi.stubEnv('OPENEI_API_KEY', 'test-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(Array.from({ length: 500 }, (_, i) => ({ label: `label-${i}` }))))
      .mockResolvedValueOnce(response([{ label: 'last-label' }]));
    vi.stubGlobal('fetch', fetchMock);

    const rates = await ratesEffectiveOn('We Energies', '2026-04-28', 'America/Chicago');

    expect(rates).toHaveLength(501);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(call => new URL(String(call[0])));
    expect(urls.map(url => url.searchParams.get('offset'))).toEqual(['0', '500']);
  });

  it('pages utility names using MediaWiki continuation', async () => {
    vi.stubEnv('OPENEI_API_KEY', 'test-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          query: { categorymembers: [{ title: 'Utility A' }, { title: 'Utility B' }] },
          continue: { cmcontinue: 'page-2', continue: '-||' },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ query: { categorymembers: [{ title: 'Utility C' }] } }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    // The utility directory is exposed as a MediaWiki category, not the broken offset endpoint.
    const { utilityNames } = await import('./client');
    const names = await utilityNames();

    expect(names).toEqual(['Utility A', 'Utility B', 'Utility C']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(call => new URL(String(call[0])));
    expect(urls[0]?.searchParams.get('action')).toBe('query');
    expect(urls[0]?.searchParams.get('cmtitle')).toBe('Category:EIA Utility Companies and Aliases');
    expect(urls[1]?.searchParams.get('cmcontinue')).toBe('page-2');
    expect(urls[1]?.searchParams.get('continue')).toBe('-||');
  });

  it('sends effective_on_date as local noon', async () => {
    vi.stubEnv('OPENEI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);

    await ratesEffectiveOn('We Energies', '2026-04-28', 'America/Chicago');

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('effective_on_date')).toBe(
      String(Date.parse('2026-04-28T17:00:00Z') / 1000)
    );
    expect(url.searchParams.get('ratesforutility')).toBe('We Energies');
    expect(url.searchParams.has('utility')).toBe(false);
  });

  it('throws UrdbUnavailableError without a key', async () => {
    vi.stubEnv('OPENEI_API_KEY', '');

    await expect(ratesEffectiveOn('We Energies', '2026-04-28', 'America/Chicago'))
      .rejects.toBeInstanceOf(UrdbUnavailableError);
  });
});
