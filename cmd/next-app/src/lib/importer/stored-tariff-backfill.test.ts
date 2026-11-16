import { describe, expect, it, vi } from 'vitest';
import type { TariffV2 } from '../tesla-client';
import { parseTariffContent, type ParsedTariff } from './tariff-parser';
import { backfillStoredTariffs, type StoredTariffSite } from './stored-tariff-backfill';

const content = {
  name: 'EV2-A',
  code: 'EV2A',
  utility: 'Pacific Gas & Electric',
  seasons: {
    Summer: {
      fromMonth: 6, fromDay: 1, toMonth: 9, toDay: 30,
      tou_periods: { OFF_PEAK: { periods: [{ fromDayOfWeek: 0, toDayOfWeek: 6, fromHour: 0, fromMinute: 0, toHour: 0, toMinute: 0 }] } },
    },
    Winter: {},
  },
  energy_charges: { Summer: { rates: { OFF_PEAK: 0.3 } } },
} as unknown as TariffV2;

function site(overrides: Partial<StoredTariffSite> = {}): StoredTariffSite {
  return { id: 'site-1', json: { site_name: 'Home', tariff_content_v2: content }, ...overrides };
}

describe('backfillStoredTariffs', () => {
  it('reports what it would store without writing in a dry run', async () => {
    const addTariffVersion = vi.fn();

    const result = await backfillStoredTariffs([site()], { addTariffVersion }, { apply: false });

    expect(addTariffVersion).not.toHaveBeenCalled();
    expect(result).toEqual([{ siteId: 'site-1', outcome: 'would_store', planName: 'EV2-A', seasons: 1, skippedEmptySeasons: 1 }]);
  });

  it('stores the plan exactly as the importer would, with its Tesla name and code', async () => {
    const addTariffVersion = vi.fn<(siteId: string, parsed: ParsedTariff, metadata?: { name: string | null; code: string | null }, options?: { requireNoTariff?: boolean }) => Promise<boolean>>()
      .mockResolvedValue(true);

    const result = await backfillStoredTariffs([site()], { addTariffVersion }, { apply: true });

    expect(addTariffVersion).toHaveBeenCalledWith('site-1', parseTariffContent(content, 'Home'), { name: 'EV2-A', code: 'EV2A' }, { requireNoTariff: true });
    expect(result[0]).toMatchObject({ siteId: 'site-1', outcome: 'stored' });
  });

  it('falls back to the importer default site name when Tesla gave none', async () => {
    const addTariffVersion = vi.fn().mockResolvedValue(true);
    const noUtility = { ...content, utility: undefined } as unknown as TariffV2;

    await backfillStoredTariffs([site({ json: { tariff_content_v2: noUtility } })], { addTariffVersion }, { apply: true });

    expect(addTariffVersion.mock.calls[0][1].name).toBe('Utility Tariff');
  });

  it('skips sites whose stored plan has no usable season or no plan at all', async () => {
    const addTariffVersion = vi.fn();
    const empty = { ...content, seasons: { Winter: {} } } as unknown as TariffV2;

    const result = await backfillStoredTariffs([
      site({ id: 'empty', json: { tariff_content_v2: empty } }),
      site({ id: 'none', json: {} }),
      site({ id: 'null-json', json: null }),
    ], { addTariffVersion }, { apply: true });

    expect(addTariffVersion).not.toHaveBeenCalled();
    expect(result.map(r => [r.siteId, r.outcome])).toEqual([['empty', 'no_usable_season'], ['none', 'no_plan'], ['null-json', 'no_plan']]);
  });

  it('asks the repo to recheck under its lock and reports a site that gained a tariff meanwhile', async () => {
    const addTariffVersion = vi.fn().mockResolvedValue(false);

    const result = await backfillStoredTariffs([site()], { addTariffVersion }, { apply: true });

    expect(addTariffVersion.mock.calls[0][3]).toEqual({ requireNoTariff: true });
    expect(result[0].outcome).toBe('already_has_tariff');
  });

  it('keeps going after one site fails and reports the failure', async () => {
    const addTariffVersion = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(true);

    const result = await backfillStoredTariffs([site({ id: 'a' }), site({ id: 'b' })], { addTariffVersion }, { apply: true });

    expect(result.map(r => [r.siteId, r.outcome])).toEqual([['a', 'failed'], ['b', 'stored']]);
    expect(result[0].error).toBe('boom');
  });
});
