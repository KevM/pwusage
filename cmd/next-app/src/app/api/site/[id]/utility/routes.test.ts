import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), verifySiteAccess: vi.fn(), isCrossOriginRequest: vi.fn(),
  utilityNames: vi.fn(), ratesEffectiveOn: vi.fn(),
  getSiteUtilityContext: vi.fn(), loadSitePublicConversionContext: vi.fn(), setSiteUtility: vi.fn(), setSitePlanLabel: vi.fn(),
  poolQuery: vi.fn(), poolConnect: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  pool: { query: mocks.poolQuery, connect: mocks.poolConnect },
}));

vi.mock('@/lib/auth-checks', () => ({
  getCurrentUser: mocks.getCurrentUser, verifySiteAccess: mocks.verifySiteAccess,
}));
vi.mock('@/lib/request-security', () => ({ isCrossOriginRequest: mocks.isCrossOriginRequest }));
vi.mock('@/lib/io-deadline', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/io-deadline')>(),
  withIoDeadline: (_ms: number, action: () => Promise<unknown>) => action(),
}));
vi.mock('@/lib/observability', () => ({
  observeRoute: (_name: string, handler: (request: NextRequest, context: unknown) => Promise<Response>) => handler,
  errorFields: () => ({}), flushLogEvents: vi.fn(), logEvent: vi.fn(), setLogContext: vi.fn(),
}));
vi.mock('@/lib/urdb/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/urdb/client')>(),
  utilityNames: mocks.utilityNames,
  ratesEffectiveOn: mocks.ratesEffectiveOn,
}));
vi.mock('@/lib/tariff-timeline-repo', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tariff-timeline-repo')>();
  return {
    ...actual,
    TariffTimelineRepo: class {
      getSiteUtilityContext = mocks.getSiteUtilityContext;
      loadSitePublicConversionContext = mocks.loadSitePublicConversionContext;
      setSiteUtility = mocks.setSiteUtility;
      setSitePlanLabel = mocks.setSitePlanLabel;
    },
  };
});
vi.mock('@/lib/urdb/estimate-job', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/urdb/estimate-job')>(),
  monthlyUsage: async () => 600,
}));

import { PUT as saveUtility } from './route';
import { GET as searchUtilities } from './search/route';
import * as plansRoute from './plans/route';
import { GET as listPlans } from './plans/route';
import { PUT as savePlan } from './plan/route';
import { UrdbUnavailableError } from '@/lib/urdb/client';

const context = { params: Promise.resolve({ id: 'site-1' }) };
const allDayRate = {
  label: 'valid-plan', name: 'Residential', utility: 'We Energies', startdate: 1_767_225_600,
  energyratestructure: [[{ rate: 0.2 }]],
  energyweekdayschedule: Array.from({ length: 12 }, () => Array(24).fill(0)),
  energyweekendschedule: Array.from({ length: 12 }, () => Array(24).fill(0)),
};

describe('utility and plan routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' });
    mocks.verifySiteAccess.mockResolvedValue(true);
    mocks.isCrossOriginRequest.mockReturnValue(false);
    mocks.utilityNames.mockResolvedValue(['We Energies']);
    mocks.ratesEffectiveOn.mockResolvedValue([allDayRate]);
    mocks.getSiteUtilityContext.mockResolvedValue({ name: 'We Energies', timezone: 'America/Chicago', currency: 'USD', choice: 'owner' });
    mocks.loadSitePublicConversionContext.mockResolvedValue({ fallbackSellRate: 0.04, hasTeslaSellFallback: true });
    mocks.setSiteUtility.mockResolvedValue({ version: 2, periods: [] });
    mocks.setSitePlanLabel.mockResolvedValue({ version: 2, periods: [] });
  });

  it('requires site access for utility search', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    const response = await searchUtilities(new NextRequest('https://app.test/api/site/site-1/utility/search?q=we'), context);
    expect(response.status).toBe(401);
    expect(mocks.utilityNames).not.toHaveBeenCalled();
  });

  it('rejects cross-origin utility writes and short search queries', async () => {
    mocks.isCrossOriginRequest.mockReturnValueOnce(true);
    const crossOrigin = await saveUtility(new NextRequest('https://app.test/api/site/site-1/utility', {
      method: 'PUT', body: JSON.stringify({ skipped: true }),
    }), context);
    expect(crossOrigin.status).toBe(403);

    const shortQuery = await searchUtilities(new NextRequest('https://app.test/api/site/site-1/utility/search?q=w'), context);
    expect(shortQuery.status).toBe(400);
  });

  it('validates and saves a selected utility', async () => {
    const response = await saveUtility(new NextRequest('https://app.test/api/site/site-1/utility', {
      method: 'PUT', body: JSON.stringify({ name: 'We Energies' }),
    }), context);
    expect(response.status).toBe(200);
    expect(mocks.setSiteUtility).toHaveBeenCalledWith('site-1', 'user-1', { name: 'We Energies' });

    const skipped = await saveUtility(new NextRequest('https://app.test/api/site/site-1/utility', {
      method: 'PUT', body: JSON.stringify({ skipped: true }),
    }), context);
    expect(skipped.status).toBe(200);
    expect(mocks.setSiteUtility).toHaveBeenLastCalledWith('site-1', 'user-1', { skipped: true });
  });

  it('rejects an invalid utility and maps unavailable URDB to 503', async () => {
    const invalid = await saveUtility(new NextRequest('https://app.test/api/site/site-1/utility', {
      method: 'PUT', body: JSON.stringify({ name: 'Not Listed' }),
    }), context);
    expect(invalid.status).toBe(400);

    mocks.utilityNames.mockRejectedValueOnce(new UrdbUnavailableError('No key'));
    const unavailable = await saveUtility(new NextRequest('https://app.test/api/site/site-1/utility', {
      method: 'PUT', body: JSON.stringify({ name: 'We Energies' }),
    }), context);
    expect(unavailable.status).toBe(503);
  });

  it('requires a utility before listing or saving a plan', async () => {
    mocks.getSiteUtilityContext.mockResolvedValue({ name: null, timezone: 'UTC' });
    const listed = await listPlans(new NextRequest('https://app.test/api/site/site-1/utility/plans'), context);
    expect(listed.status).toBe(409);
    const saved = await savePlan(new NextRequest('https://app.test/api/site/site-1/utility/plan', {
      method: 'PUT', body: JSON.stringify({ label: 'valid-plan' }),
    }), context);
    expect(saved.status).toBe(409);
    expect(mocks.ratesEffectiveOn).not.toHaveBeenCalled();
  });

  it('lists selectable plans and saves a valid selection', async () => {
    const listed = await listPlans(new NextRequest('https://app.test/api/site/site-1/utility/plans'), context);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ plans: [{ label: 'valid-plan', name: 'Residential' }] });

    const saved = await savePlan(new NextRequest('https://app.test/api/site/site-1/utility/plan', {
      method: 'PUT', body: JSON.stringify({ label: 'valid-plan' }),
    }), context);
    expect(saved.status).toBe(200);
    expect(mocks.setSitePlanLabel).toHaveBeenCalledWith('site-1', 'user-1', 'valid-plan', 'We Energies');
  });

  it('rejects unlisted plans and maps plan lookup failure to 503', async () => {
    const invalid = await savePlan(new NextRequest('https://app.test/api/site/site-1/utility/plan', {
      method: 'PUT', body: JSON.stringify({ label: 'unknown-label' }),
    }), context);
    expect(invalid.status).toBe(400);

    mocks.ratesEffectiveOn.mockRejectedValueOnce(new UrdbUnavailableError('OpenEI unavailable'));
    const unavailable = await listPlans(new NextRequest('https://app.test/api/site/site-1/utility/plans'), context);
    expect(unavailable.status).toBe(503);
  });

  it('supports effectiveDate browsing and returns complete rate details and approximation notes', async () => {
    mocks.ratesEffectiveOn.mockResolvedValueOnce([
      {
        label: 'tiered-plan',
        name: 'Tiered Plan',
        utility: 'We Energies',
        startdate: 1_735_689_600,
        dgrules: 'Buy All Sell All',
        energyratestructure: [
          [{ rate: 0.1, max: 300, unit: 'kWh' }, { rate: 0.2, unit: 'kWh' }],
        ],
        energyweekdayschedule: Array.from({ length: 12 }, () => Array(24).fill(0)),
        energyweekendschedule: Array.from({ length: 12 }, () => Array(24).fill(0)),
      },
    ]);

    const res = await listPlans(
      new NextRequest('https://app.test/api/site/site-1/utility/plans?effectiveDate=2025-04-01'),
      context
    );
    expect(res.status).toBe(200);
    expect(mocks.ratesEffectiveOn).toHaveBeenCalledWith('We Energies', '2025-04-01', 'America/Chicago');
    const body = await res.json();
    expect(body).toMatchObject({
      utilityName: 'We Energies',
      effectiveDate: '2025-04-01',
      currency: 'USD',
      unit: 'kWh',
    });
    expect(body.plans[0]).toMatchObject({
      label: 'tiered-plan',
      name: 'Tiered Plan',
      exportRateProvenance: 'inherited',
    });
    expect(body.plans[0].seasons[0].weekdayPeriods[0]).toMatchObject({
      buyRate: 0.15,
      sellRate: 0.04,
    });
    expect(body.plans[0].approximationNotes.map((n: { kind: string }) => n.kind)).toEqual([
      'tier_blended',
      'export_inherited_from_tesla',
    ]);

    const badDate = await listPlans(
      new NextRequest('https://app.test/api/site/site-1/utility/plans?effectiveDate=2025-02-29'),
      context
    );
    expect(badDate.status).toBe(400);

    mocks.getSiteUtilityContext.mockResolvedValueOnce({ name: 'We Energies', timezone: 'America/Chicago', currency: 'EUR', choice: 'owner' });
    const badCurrency = await listPlans(
      new NextRequest('https://app.test/api/site/site-1/utility/plans'),
      context
    );
    expect(badCurrency.status).toBe(400);
  });

  it('does not expose POST /utility/plans and legacy utility mutations preserve explicit owner selections', async () => {
    expect('POST' in plansRoute).toBe(false);

    const actualMod = await vi.importActual<typeof import('@/lib/tariff-timeline-repo')>('@/lib/tariff-timeline-repo');
    const actualRepo = new actualMod.TariffTimelineRepo();
    const clientQueries: string[] = [];
    const protectedPublicRow = {
      id: 21,
      tariff_id: 77,
      source: 'estimated' as const,
      effective_from: '2025-01-01',
      effective_to: null,
      updated_by_user_id: 'user-1',
      selection_id: 501,
      choice_kind: 'owner' as const,
    };

    const fakeClient = {
      query: vi.fn(async (sql: string) => {
        clientQueries.push(sql);
        if (sql.includes('SELECT id FROM "Site" WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ id: 'site-1' }], rowCount: 1 };
        }
        if (sql.includes('UPDATE "SiteUtility" SET urdb_plan_label = $2')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT timezone FROM "Site" WHERE id = $1')) {
          return { rows: [{ timezone: 'America/Chicago' }], rowCount: 1 };
        }
        if (sql.includes('FROM "TariffEffectivePeriod" p') && sql.includes('ORDER BY effective_from ASC')) {
          return { rows: [protectedPublicRow] };
        }
        if (sql.includes('FROM "TariffEffectivePeriod"') && sql.includes('effective_from <= $2::date')) {
          return { rows: [{ tariff_id: 77 }] };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    mocks.poolConnect.mockResolvedValue(fakeClient);
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "Site"') && sql.includes('WHERE id = $1')) {
        return { rows: [{ id: 'site-1', timezone: 'America/Chicago', installed: '2024-01-01T00:00:00Z', currency: 'USD' }] };
      }
      if (sql.includes('FROM "TariffEffectivePeriod" p')) {
        return {
          rows: [{
            period_id: 21,
            tariff_id: 77,
            effective_from: '2025-01-01',
            effective_to: null,
            source: 'estimated',
            updated_by_user_id: 'user-1',
            updated_by_email: 'owner@example.com',
            name: 'Owner Public Plan',
            version: 1,
            content_hash: 'h-pub',
            selection_id: 501,
            choice_kind: 'owner',
            candidate_kind: 'public',
            selected_by_user_id: 'user-1',
            urdb_label: 'valid-plan',
            utility_name: 'We Energies',
            revision_start: '2026-01-01',
            export_rate_provenance: 'published',
            holidays_use_weekend: true,
            approximation_notes: [],
          }],
        };
      }
      return { rows: [] };
    });

    mocks.setSitePlanLabel.mockImplementation((...args: Parameters<typeof actualRepo.setSitePlanLabel>) =>
      actualRepo.setSitePlanLabel(...args)
    );
    mocks.setSiteUtility.mockImplementation((...args: Parameters<typeof actualRepo.setSiteUtility>) =>
      actualRepo.setSiteUtility(...args)
    );

    const savePlanRes = await savePlan(
      new NextRequest('https://app.test/api/site/site-1/utility/plan', {
        method: 'PUT',
        body: JSON.stringify({ label: 'valid-plan' }),
      }),
      context
    );
    expect(savePlanRes.status).toBe(200);
    expect(clientQueries.some(q => q.includes('FROM "TariffEffectivePeriod"'))).toBe(false);
    expect(clientQueries.some(q => q.includes('FROM "TariffSelection"'))).toBe(false);

    clientQueries.length = 0;
    const skipRes = await saveUtility(
      new NextRequest('https://app.test/api/site/site-1/utility', {
        method: 'PUT',
        body: JSON.stringify({ skipped: true }),
      }),
      context
    );
    expect(skipRes.status).toBe(200);
    expect(clientQueries.some(q => q.includes('DELETE FROM "TariffEffectivePeriod"'))).toBe(false);
    expect(clientQueries.some(q => q.includes('INSERT INTO "TariffEffectivePeriod"'))).toBe(false);
    const deleteUrdbSql = clientQueries.find(q => q.includes('DELETE FROM "TariffUrdbSource"'));
    expect(deleteUrdbSql).toContain("s.choice_kind = 'owner'");
    const skipBody = await skipRes.json();
    expect(skipBody.periods[0]).toMatchObject({
      periodId: 21,
      source: 'estimated',
      choiceKind: 'owner',
    });
  });
});
