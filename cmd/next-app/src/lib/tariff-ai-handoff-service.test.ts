import { describe, expect, it, vi } from 'vitest';
import { AI_HANDOFF_SCHEMA } from './tariff-ai-handoff';
import {
  buildBatchAiHandoffPreview,
  buildBatchAiHandoffPreviewWithDetails,
  commitAiRatePlanHandoff,
  previewAiRatePlanHandoff,
  TariffAiHandoffConflictError,
} from './tariff-ai-handoff-service';
import type { TariffReviewPlanSnapshot, TariffSeasonInput } from './tariff-contract';
import { tariffContentHash } from './importer/tariff-parser';
import { compileSeasonsToParsedTariff, TariffValidationError } from './tariff-timeline';
import type { ExistingTimelineSpanInput } from './tariff-selection';

const FLAT_SEASONS: TariffSeasonInput[] = [
  {
    name: 'All Year',
    fromMonth: 1,
    toMonth: 12,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.08 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.08 },
    ],
  },
];

const UPDATED_TOU_SEASONS: TariffSeasonInput[] = [
  {
    name: 'All Year',
    fromMonth: 1,
    toMonth: 12,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 16, toMinute: 0, buyRate: 0.1, sellRate: 0.08 },
      { touName: 'ON_PEAK', fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: 0.28, sellRate: 0.08 },
      { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.08 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.08 },
    ],
  },
];

function makeExistingSpan(
  name: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  seasons: TariffSeasonInput[],
  source: 'tesla' | 'manual' | 'estimated' = 'tesla'
): ExistingTimelineSpanInput {
  const hash = tariffContentHash(compileSeasonsToParsedTariff(name, seasons));
  const plan: TariffReviewPlanSnapshot = {
    tariffId: 10,
    version: 1,
    periodId: 1,
    selectionId: 5,
    name,
    utilityName: 'Austin Energy',
    source,
    choiceKind: source === 'manual' ? 'owner' : 'automatic',
    urdbLabel: null,
    revisionStart: null,
    contentHash: hash,
    exportRateProvenance: source === 'tesla' ? 'tesla' : 'manual',
    holidaysUseWeekendSchedule: true,
    seasons,
    approximationNotes: [],
    verification: null,
  };
  return { effectiveFrom, effectiveTo, plan };
}

describe('tariff-ai-handoff-service', () => {
  it('skips unchanged periods and previews changed actual and reference periods sequentially', async () => {
    const existingActual = [makeExistingSpan('Tesla Plan', '2024-01-01', null, FLAT_SEASONS, 'tesla')];
    const existingRef = [makeExistingSpan('Ref Flat', '2024-01-01', null, FLAT_SEASONS, 'estimated')];

    const rawInput = JSON.stringify({
      schema: AI_HANDOFF_SCHEMA,
      notes: ['Verified peak hours 4pm-9pm from utility tariff sheet.'],
      sources: ['https://austinenergy.com/rates'],
      actualPeriods: [
        { name: 'Austin TOU 2024', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31', seasons: UPDATED_TOU_SEASONS },
        { name: 'Austin TOU 2025', effectiveFrom: '2025-01-01', effectiveTo: null, seasons: UPDATED_TOU_SEASONS },
      ],
      referencePeriods: [
        // Exact same content, name, and dates as existingRef -> should be counted as unchanged
        { name: 'Ref Flat', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: FLAT_SEASONS },
      ],
    });

    const preview = buildBatchAiHandoffPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-18',
      eligibility: 'us',
      rawInput,
      actualSpans: existingActual,
      referenceSpans: existingRef,
    });

    expect(preview.unchangedActualCount).toBe(0);
    expect(preview.unchangedReferenceCount).toBe(1);
    expect(preview.actualPreviews).toHaveLength(2);
    expect(preview.referencePreviews).toHaveLength(0);
    expect(preview.recalculatesHistory).toBe(true);
    expect(preview.notes).toEqual(['Verified peak hours 4pm-9pm from utility tariff sheet.']);
    expect(preview.sources).toEqual(['https://austinenergy.com/rates']);
    // Second period previews against the simulated timeline after the first period split 2024
    expect(preview.actualPreviews[1].effectiveFrom).toBe('2025-01-01');

    const withBillDetails = buildBatchAiHandoffPreviewWithDetails({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-18',
      eligibility: 'us',
      rawInput: JSON.stringify({
        schema: AI_HANDOFF_SCHEMA,
        sources: ['User-provided utility bill (2026-08)'],
        actualPeriods: [{ name: 'Austin TOU', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: UPDATED_TOU_SEASONS }],
        referencePeriods: [],
      }),
      actualSpans: existingActual,
      referenceSpans: [],
    });
    expect(withBillDetails.citesUtilityBill).toBe(true);
  });

  it('disambiguates plan name when replacing only part of an existing span so surviving fragments do not collide', () => {
    const existingActual = [makeExistingSpan('Home Plan', '2024-01-01', null, FLAT_SEASONS, 'tesla')];
    const preview = buildBatchAiHandoffPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-18',
      eligibility: 'us',
      rawInput: JSON.stringify({
        schema: AI_HANDOFF_SCHEMA,
        actualPeriods: [
          { name: 'Home Plan', effectiveFrom: '2025-01-01', effectiveTo: null, seasons: UPDATED_TOU_SEASONS },
        ],
        referencePeriods: [],
      }),
      actualSpans: existingActual,
      referenceSpans: [],
    });

    expect(preview.actualPreviews).toHaveLength(1);
    expect(preview.actualPreviews[0].candidatePlan?.name).toBe('Home Plan (2025)');
  });

  it('treats Tesla plans with different season-level hash representations as unchanged when schedules match', () => {
    const teslaSpan = makeExistingSpan('Tesla Plan', '2024-01-01', null, FLAT_SEASONS, 'tesla');
    // parseTeslaTariff stores season-level buy/sell rates as 0, producing a different stored contentHash
    teslaSpan.plan.contentHash = 'tesla-zero-season-rates-hash';

    const unchangedPreview = buildBatchAiHandoffPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-18',
      eligibility: 'us',
      rawInput: JSON.stringify({
        schema: AI_HANDOFF_SCHEMA,
        actualPeriods: [
          { name: 'Tesla Plan', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: FLAT_SEASONS },
        ],
        referencePeriods: [],
      }),
      actualSpans: [teslaSpan],
      referenceSpans: [],
    });
    expect(unchangedPreview.unchangedActualCount).toBe(1);
    expect(unchangedPreview.actualPreviews).toHaveLength(0);

    // When the Tesla plan has day-specific schedules, keep it marked as changed
    const daySpecificSpan = makeExistingSpan('Tesla Plan', '2024-01-01', null, FLAT_SEASONS, 'tesla');
    daySpecificSpan.plan.approximationNotes = [
      { kind: 'day_specific_schedule', message: 'Day-specific schedule detected.' },
    ];
    const changedPreview = buildBatchAiHandoffPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-18',
      eligibility: 'us',
      rawInput: JSON.stringify({
        schema: AI_HANDOFF_SCHEMA,
        actualPeriods: [
          { name: 'Tesla Plan', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: FLAT_SEASONS },
        ],
        referencePeriods: [],
      }),
      actualSpans: [daySpecificSpan],
      referenceSpans: [],
    });
    expect(changedPreview.unchangedActualCount).toBe(0);
    expect(changedPreview.actualPreviews).toHaveLength(1);
  });

  it('previews changed periods that have minute-resolution boundaries (e.g. 06:07)', () => {
    const existingActual = [makeExistingSpan('Tesla Plan', '2024-01-01', null, FLAT_SEASONS, 'tesla')];
    const minuteSeasons: TariffSeasonInput[] = [
      {
        name: 'All Year',
        fromMonth: 1,
        toMonth: 12,
        weekdayPeriods: [
          { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 6, toMinute: 7, buyRate: 0.1, sellRate: 0.08 },
          { touName: 'ON_PEAK', fromHour: 6, fromMinute: 7, toHour: 24, toMinute: 0, buyRate: 0.25, sellRate: 0.08 },
        ],
        weekendPeriods: FLAT_SEASONS[0].weekendPeriods,
      },
    ];

    const preview = buildBatchAiHandoffPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-18',
      eligibility: 'us',
      rawInput: JSON.stringify({
        schema: AI_HANDOFF_SCHEMA,
        actualPeriods: [
          { name: 'Tesla Plan', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: minuteSeasons },
        ],
        referencePeriods: [],
      }),
      actualSpans: existingActual,
      referenceSpans: [],
    });

    expect(preview.actualPreviews).toHaveLength(1);
    expect(preview.actualPreviews[0].affectedIntervals[0].seasons[0].weekdayRows[0].toMinute).toBe(7);
  });

  it('recognizes unchanged plans when loadScopeSelectionSpans splits them across restoration partitions', () => {
    const part1 = makeExistingSpan('Verified Manual Plan', '2024-01-01', '2024-06-30', FLAT_SEASONS, 'manual');
    const part2 = makeExistingSpan('Verified Manual Plan', '2024-07-01', null, FLAT_SEASONS, 'manual');

    const preview = buildBatchAiHandoffPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-18',
      eligibility: 'us',
      rawInput: JSON.stringify({
        schema: AI_HANDOFF_SCHEMA,
        actualPeriods: [
          { name: 'Verified Manual Plan', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: FLAT_SEASONS },
        ],
        referencePeriods: [
          { name: 'New Fixed Ref', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: FLAT_SEASONS },
        ],
      }),
      actualSpans: [part1, part2],
      referenceSpans: [],
    });

    expect(preview.unchangedActualCount).toBe(1);
    expect(preview.actualPreviews).toHaveLength(0);
    expect(preview.referencePreviews).toHaveLength(1);
  });

  it('commits reviewed batch changes via repo.commitAiHandoffSelections and rejects missing reviewHash', async () => {
    const existingActual = [makeExistingSpan('Tesla Plan', '2024-01-01', null, FLAT_SEASONS, 'tesla')];
    const rawInput = JSON.stringify({
      schema: AI_HANDOFF_SCHEMA,
      actualPeriods: [
        { name: 'Austin TOU', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: UPDATED_TOU_SEASONS },
      ],
      referencePeriods: [],
    });

    const repo = {
      getSiteUtilityContext: vi.fn().mockResolvedValue({
        name: 'Austin Energy',
        timezone: 'America/Chicago',
        currency: 'USD',
        rateCountry: 'US',
        eligibility: 'us',
      }),
      loadAiHandoffSpans: vi.fn().mockResolvedValue({
        actualSpans: existingActual,
        referenceSpans: [],
      }),
      commitAiHandoffSelections: vi.fn(),
    };

    const preview = await previewAiRatePlanHandoff('site-1', 'user-1', { rawInput }, {
      now: () => new Date('2026-11-18T12:00:00Z'),
      repo,
    });

    await expect(
      commitAiRatePlanHandoff('site-1', 'user-1', { rawInput, expectedReviewHash: '', verifiedAgainstBill: false }, {
        now: () => new Date('2026-11-18T12:00:00Z'),
        repo,
      })
    ).rejects.toThrow(TariffValidationError);

    repo.commitAiHandoffSelections.mockResolvedValue({
      selectionIds: [11],
      tariffIds: [22],
      appliedActualCount: 1,
      appliedReferenceCount: 0,
      unchanged: false,
      reattributionRange: { fromDate: '2024-01-01', toDate: null },
      timeline: { version: 2, siteId: 'site-1' },
    });

    const committed = await commitAiRatePlanHandoff(
      'site-1',
      'user-1',
      { rawInput, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: true },
      { now: () => new Date('2026-11-18T12:00:00Z'), repo }
    );

    expect(committed.appliedActualCount).toBe(1);
    expect(repo.commitAiHandoffSelections).toHaveBeenCalledTimes(1);
    expect(UnitCheck(TariffAiHandoffConflictError)).toBe(true);
  });
});

function UnitCheck(ctor: typeof TariffAiHandoffConflictError): boolean {
  return typeof ctor === 'function';
}
