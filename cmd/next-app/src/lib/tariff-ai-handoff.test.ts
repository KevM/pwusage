import { describe, expect, it } from 'vitest';
import type { SiteTariffsTimelineResponse, TariffPeriodDTO, TariffSeasonInput } from './tariff-contract';
import {
  AI_HANDOFF_SCHEMA,
  buildRatePlanAiHandoffMarkdown,
  isTimeOfUsePeriod,
  parseRatePlanAiHandoffInput,
  sourcesCiteUtilityBill,
} from './tariff-ai-handoff';
import { TariffValidationError } from './tariff-timeline';

const SUMMER_TOU_SEASONS: TariffSeasonInput[] = [
  {
    name: 'Summer',
    fromMonth: 6,
    toMonth: 9,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 14, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
      { touName: 'ON_PEAK', fromHour: 14, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.225, sellRate: 0.097 },
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
    ],
  },
  {
    name: 'Non-Summer',
    fromMonth: 10,
    toMonth: 5,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
    ],
  },
];

const FLAT_SEASONS: TariffSeasonInput[] = [
  {
    name: 'All Year',
    fromMonth: 1,
    toMonth: 12,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.115, sellRate: 0.097 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.115, sellRate: 0.097 },
    ],
  },
];

function sampleTimeline(): SiteTariffsTimelineResponse {
  const actualPeriod: TariffPeriodDTO = {
    periodId: 42,
    tariffId: 101,
    name: 'Residential Time of Use',
    version: 3,
    source: 'estimated',
    startSource: 'urdb',
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    isCurrentToday: true,
    updatedBy: { email: 'owner-secret@example.com', isCurrentUser: true },
    seasons: SUMMER_TOU_SEASONS,
    selectionId: 77,
    choiceKind: 'owner',
    urdbLabel: '65a1b2c3d4e5f60001234567',
    verification: {
      verifiedAt: '2026-10-01T15:30:00.000Z',
      verifiedByEmail: 'verifier-secret@example.com',
      verifiedByCurrentUser: true,
    },
  };

  const referencePeriod: TariffPeriodDTO = {
    periodId: 88,
    tariffId: 202,
    name: 'Residential Standard Fixed',
    version: 1,
    source: 'manual',
    startSource: null,
    effectiveFrom: '2023-06-15',
    effectiveTo: null,
    isCurrentToday: true,
    updatedBy: { email: 'owner-secret@example.com', isCurrentUser: true },
    seasons: FLAT_SEASONS,
    selectionId: 78,
    choiceKind: 'owner',
    urdbLabel: null,
    verification: null,
  };

  return {
    version: 2,
    siteId: 'secret-site-id-99999',
    timezone: 'America/Chicago',
    currency: 'USD',
    periods: [actualPeriod],
    referencePeriods: [referencePeriod],
    estimates: {
      status: 'ready',
      utilityName: 'Austin Energy',
      teslaPlanOutOfDate: true,
      newerPlanName: 'Residential TOU 2026',
      newerPlanStart: '2026-03-01',
      newestRevisionStart: '2025-11-01',
      mayBeOutdated: false,
      historyGuide: {
        historyStart: '2023-06-15',
        fillThrough: '2023-12-31',
        unconfirmedDays: 200,
      },
      eligibility: 'us',
    },
    rateCountry: {
      countryCode: 'US',
      source: 'owner',
      updatedAt: '2026-11-01T00:00:00.000Z',
      eligibility: 'us',
    },
    battery: null,
    systemCosts: {
      siteInstalled: '2023-06-15',
      solar: null,
      powerwall: null,
    },
    reattribution: null,
    holidayDates: ['2026-01-01', '2026-07-03'],
    teslaSync: {
      latestTariffId: 55,
      latestTariffName: 'Austin Energy TOU (Old)',
      latestUpdatedAt: '2025-05-10T12:00:00.000Z',
      activeManualUpdatedAt: '2026-10-01T15:30:00.000Z',
      differsFromActiveManual: true,
    },
  };
}

describe('tariff-ai-handoff', () => {
  it('detects Time of Use vs fixed periods', () => {
    expect(isTimeOfUsePeriod({ seasons: SUMMER_TOU_SEASONS })).toBe(true);
    expect(isTimeOfUsePeriod({ seasons: FLAT_SEASONS })).toBe(false);
  });

  it('exports all period metadata, site hints, uncovered gaps, and utility bill fallback while omitting PII', () => {
    const timeline = sampleTimeline();
    const md = buildRatePlanAiHandoffMarkdown(timeline, '2026-11-18');

    // Includes site & period metadata
    expect(md).toContain('Austin Energy');
    expect(md).toContain('America/Chicago');
    expect(md).toContain('2023-06-15');
    expect(md).toContain('Residential Time of Use');
    expect(md).toContain('Version 3');
    expect(md).toContain('From public utility rates');
    expect(md).toContain('Chosen by homeowner');
    expect(md).toContain('65a1b2c3d4e5f60001234567');
    expect(md).toContain('Verified against utility bill on 2026-10-01');
    expect(md).toContain('Austin Energy TOU (Old)');
    expect(md).toContain('Residential TOU 2026');
    expect(md).toContain('2026-03-01');
    // Uncovered gap from siteInstalled (2023-06-15) to day before 2024-01-01 (2023-12-31)
    expect(md).toContain('2023-06-15');
    expect(md).toContain('2023-12-31');
    // Includes utility bill upload instructions and fixed comparison plan requirement
    expect(md).toContain('utility bill');
    expect(md).toContain('Fixed comparison plan');

    // Zero PII
    expect(md).not.toContain('secret-site-id-99999');
    expect(md).not.toContain('owner-secret@example.com');
    expect(md).not.toContain('verifier-secret@example.com');
  });

  it('round-trips exported Markdown through parseRatePlanAiHandoffInput identically', () => {
    const timeline = sampleTimeline();
    const md = buildRatePlanAiHandoffMarkdown(timeline, '2026-11-18');
    const parsed = parseRatePlanAiHandoffInput(md, '2026-11-18');

    expect(parsed.schema).toBe(AI_HANDOFF_SCHEMA);
    expect(parsed.actualPeriods).toHaveLength(1);
    expect(parsed.actualPeriods[0]).toEqual({
      name: 'Residential Time of Use',
      effectiveFrom: '2024-01-01',
      effectiveTo: null,
      seasons: SUMMER_TOU_SEASONS,
    });
    expect(parsed.referencePeriods).toHaveLength(1);
    expect(parsed.referencePeriods[0]).toEqual({
      name: 'Residential Standard Fixed',
      effectiveFrom: '2023-06-15',
      effectiveTo: null,
      seasons: FLAT_SEASONS,
    });
  });

  it('parses fenced JSON amidst AI commentary and extracts notes and sources', () => {
    const reply = `
Here is what I found from the official Austin Energy tariff sheet and your uploaded bill:

\`\`\`json
{
  "schema": "pwusage-rate-plan-handoff/v1",
  "notes": ["Added regulatory charge of $0.012/kWh from bill."],
  "sources": ["https://austinenergy.com/rates", "User-provided utility bill (2026-08)"],
  "actualPeriods": [
    {
      "name": "Residential Time of Use",
      "effectiveFrom": "2024-01-01",
      "effectiveTo": null,
      "seasons": ${JSON.stringify(FLAT_SEASONS)}
    }
  ],
  "referencePeriods": []
}
\`\`\`
Hope this helps!
`;
    const parsed = parseRatePlanAiHandoffInput(reply, '2026-11-18');
    expect(parsed.notes).toEqual(['Added regulatory charge of $0.012/kWh from bill.']);
    expect(parsed.sources).toEqual(['https://austinenergy.com/rates', 'User-provided utility bill (2026-08)']);
    expect(parsed.actualPeriods).toHaveLength(1);
  });

  it('rejects overlapping periods within the same scope', () => {
    const raw = JSON.stringify({
      schema: AI_HANDOFF_SCHEMA,
      actualPeriods: [
        { name: 'Plan A', effectiveFrom: '2024-01-01', effectiveTo: '2024-06-30', seasons: FLAT_SEASONS },
        { name: 'Plan B', effectiveFrom: '2024-06-01', effectiveTo: null, seasons: FLAT_SEASONS },
      ],
      referencePeriods: [],
    });

    expect(() => parseRatePlanAiHandoffInput(raw, '2026-11-18')).toThrow(TariffValidationError);
    expect(() => parseRatePlanAiHandoffInput(raw, '2026-11-18')).toThrow(/overlap/i);
  });

  it('parses unfenced JSON surrounded by prose by extracting from first { to last }', () => {
    const reply = `Here is the updated plan:\n{"schema":"pwusage-rate-plan-handoff/v1","notes":[],"sources":[],"actualPeriods":[{"name":"Flat","effectiveFrom":"2024-01-01","effectiveTo":null,"seasons":${JSON.stringify(FLAT_SEASONS)}}],"referencePeriods":[]}\nLet me know if you need changes!`;
    const parsed = parseRatePlanAiHandoffInput(reply, '2026-11-18');
    expect(parsed.actualPeriods).toHaveLength(1);
    expect(parsed.actualPeriods[0].name).toBe('Flat');
  });

  it('detects utility bill citations separately from tariff URLs and labels ai_handoff provenance', () => {
    expect(sourcesCiteUtilityBill(['User-provided utility bill (2026-08)'])).toBe(true);
    expect(sourcesCiteUtilityBill(['https://austinenergy.com/rates'])).toBe(false);

    const timeline = sampleTimeline();
    timeline.periods[0].candidateKind = 'ai_handoff';
    const md = buildRatePlanAiHandoffMarkdown(timeline, '2026-11-18');
    expect(md).toContain('Imported with AI assistant');
  });

  it('preserves mid-month season boundaries (fromDay/toDay) across export and re-import', () => {
    const timeline = sampleTimeline();
    const midMonthSeasons: TariffSeasonInput[] = [
      {
        name: 'Summer',
        fromMonth: 6,
        fromDay: 15,
        toMonth: 9,
        toDay: 14,
        weekdayPeriods: SUMMER_TOU_SEASONS[0].weekdayPeriods,
        weekendPeriods: SUMMER_TOU_SEASONS[0].weekendPeriods,
      },
      {
        name: 'Winter',
        fromMonth: 9,
        fromDay: 15,
        toMonth: 6,
        toDay: 14,
        weekdayPeriods: SUMMER_TOU_SEASONS[1].weekdayPeriods,
        weekendPeriods: SUMMER_TOU_SEASONS[1].weekendPeriods,
      },
    ];
    timeline.periods[0].seasons = midMonthSeasons;

    const md = buildRatePlanAiHandoffMarkdown(timeline, '2026-11-18');
    const parsed = parseRatePlanAiHandoffInput(md, '2026-11-18');
    expect(parsed.actualPeriods[0].seasons).toEqual(midMonthSeasons);
  });

  it('rejects wrong schema or empty periods across both scopes', () => {
    expect(() =>
      parseRatePlanAiHandoffInput(JSON.stringify({ schema: 'wrong/v1', actualPeriods: [], referencePeriods: [] }), '2026-11-18')
    ).toThrow(TariffValidationError);

    expect(() =>
      parseRatePlanAiHandoffInput(JSON.stringify({ schema: AI_HANDOFF_SCHEMA, actualPeriods: [], referencePeriods: [] }), '2026-11-18')
    ).toThrow(/at least one rate plan/i);
  });
});
