import { describe, expect, it } from 'vitest';
import type {
  TariffApproximationNote,
  TariffReviewPlanSnapshot,
  TariffSeasonInput,
  TariffSelectionRequest,
} from './tariff-contract';
import {
  buildTariffSelectionPreview,
  compareTariffSchedules,
  compareTariffSeasons,
  validateSelectionDates,
  validateTariffSelectionCommit,
  validateTariffSelectionRequest,
} from './tariff-selection';
import { TariffValidationError } from './tariff-timeline';

const summerWinterPlanA: TariffSeasonInput[] = [
  {
    name: 'Winter',
    fromMonth: 10,
    toMonth: 5,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.3, sellRate: 0.04 },
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
    ],
  },
  {
    name: 'Summer',
    fromMonth: 6,
    toMonth: 9,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.11, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.32, sellRate: 0.05 },
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.11, sellRate: 0.03 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.11, sellRate: 0.03 },
    ],
  },
];

const shiftedWindowPlanB: TariffSeasonInput[] = [
  {
    name: 'Winter',
    fromMonth: 11,
    toMonth: 4,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 16, toMinute: 0, buyRate: 0.12, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: 0.34, sellRate: 0.04 },
      { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.03 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.03 },
    ],
  },
  {
    name: 'Summer',
    fromMonth: 5,
    toMonth: 10,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 16, toMinute: 0, buyRate: 0.12, sellRate: 0.03 },
      { touName: 'ON_PEAK', fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: 0.38, sellRate: 0.06 },
      { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.03 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.03 },
    ],
  },
];

const publicApproximationNotes: TariffApproximationNote[] = [
  { kind: 'tier_blended', message: 'Tiered rates were blended using recent monthly home use.' },
  { kind: 'export_inherited_from_tesla', message: 'Export rates were inherited from your Tesla rate plan rather than published in public utility rates.' },
];

function makePlanSnapshot(overrides: Partial<TariffReviewPlanSnapshot> & {
  name: string;
  source: TariffReviewPlanSnapshot['source'];
  seasons: TariffSeasonInput[];
}): TariffReviewPlanSnapshot {
  return {
    tariffId: null,
    version: null,
    periodId: null,
    selectionId: null,
    utilityName: 'We Energies',
    choiceKind: overrides.source === 'tesla' ? 'automatic' : 'owner',
    urdbLabel: null,
    revisionStart: null,
    contentHash: null,
    exportRateProvenance: overrides.source === 'tesla' ? 'tesla' : 'manual',
    holidaysUseWeekendSchedule: true,
    approximationNotes: [],
    verification: null,
    ...overrides,
  };
}

describe('buildTariffSelectionPreview', () => {
  it('splits a backdated replacement across two existing plans and a gap while reporting trimmed unchanged outside periods', () => {
    const planA = makePlanSnapshot({
      tariffId: 101,
      version: 1,
      periodId: 11,
      name: 'Tesla Rg2 2024',
      source: 'tesla',
      contentHash: 'hash-a',
      seasons: summerWinterPlanA,
    });
    const planB = makePlanSnapshot({
      tariffId: 102,
      version: 2,
      periodId: 12,
      name: 'Tesla Rg2 2025',
      source: 'tesla',
      contentHash: 'hash-b',
      seasons: summerWinterPlanA,
    });
    const untouchedPast = makePlanSnapshot({
      tariffId: 100,
      version: 1,
      periodId: 10,
      name: 'Tesla 2023 Plan',
      source: 'tesla',
      contentHash: 'hash-past',
      seasons: summerWinterPlanA,
    });
    const candidate = makePlanSnapshot({
      name: 'Rg2 Public 2025',
      source: 'estimated',
      choiceKind: 'owner',
      urdbLabel: 'urdb-rg2-2025',
      revisionStart: '2025-01-01',
      exportRateProvenance: 'inherited',
      approximationNotes: publicApproximationNotes,
      seasons: shiftedWindowPlanB,
    });

    const request: TariffSelectionRequest = {
      scope: 'actual',
      candidate: { kind: 'public', label: 'urdb-rg2-2025' },
      effectiveFrom: '2025-03-01',
      effectiveTo: '2025-09-30',
    };

    const preview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request,
      existingSpans: [
        { effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31', plan: untouchedPast },
        { effectiveFrom: '2025-01-01', effectiveTo: '2025-05-31', plan: planA },
        // Gap: 2025-06-01 .. 2025-06-30
        { effectiveFrom: '2025-07-01', effectiveTo: null, plan: planB },
      ],
      candidatePlan: candidate,
    });

    expect(preview.reviewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.currency).toBe('USD');
    expect(preview.unit).toBe('kWh');
    expect(preview.recalculatesHistory).toBe(true);
    expect(preview.recalculationRange).toEqual({ fromDate: '2025-03-01', toDate: '2025-09-30' });
    expect(preview.affectsPowerwallPlan).toBe(false);
    expect(preview.approximationNotes).toEqual(publicApproximationNotes);

    expect(preview.affectedIntervals.map(i => ({
      from: i.effectiveFrom,
      to: i.effectiveTo,
      kind: i.kind,
      beforeName: i.before?.name ?? null,
      afterName: i.after?.name ?? null,
    }))).toEqual([
      { from: '2025-03-01', to: '2025-05-31', kind: 'replace', beforeName: 'Tesla Rg2 2024', afterName: 'Rg2 Public 2025' },
      { from: '2025-06-01', to: '2025-06-30', kind: 'fill_gap', beforeName: null, afterName: 'Rg2 Public 2025' },
      { from: '2025-07-01', to: '2025-09-30', kind: 'replace', beforeName: 'Tesla Rg2 2025', afterName: 'Rg2 Public 2025' },
    ]);

    // First interval (Mar 1 .. May 31) splits at the May 1 candidate season boundary:
    // Mar 1 .. Apr 30 (Winter -> Winter) and May 1 .. May 31 (Winter -> Summer).
    expect(preview.affectedIntervals[0].seasons.map(s => ({
      from: `${s.fromMonth}-${s.fromDay}`,
      to: `${s.toMonth}-${s.toDay}`,
      before: s.beforeSeasonName,
      after: s.afterSeasonName,
    }))).toEqual([
      { from: '3-1', to: '4-30', before: 'Winter', after: 'Winter' },
      { from: '5-1', to: '5-31', before: 'Winter', after: 'Summer' },
    ]);

    // Time-boundary alignment on Mar 1..Apr 30 weekday splits at 08:00, 16:00, 20:00, 21:00.
    expect(preview.affectedIntervals[0].seasons[0].weekdayRows.map(r => ({
      span: `${r.fromHour}:${r.fromMinute}-${r.toHour}:${r.toMinute}`,
      beforeBuy: r.before?.buyRate ?? null,
      afterBuy: r.after?.buyRate ?? null,
      delta: r.buyRateDelta,
    }))).toEqual([
      { span: '0:0-8:0', beforeBuy: 0.1, afterBuy: 0.12, delta: 0.02 },
      { span: '8:0-16:0', beforeBuy: 0.3, afterBuy: 0.12, delta: -0.18 },
      { span: '16:0-20:0', beforeBuy: 0.3, afterBuy: 0.34, delta: 0.04 },
      { span: '20:0-21:0', beforeBuy: 0.1, afterBuy: 0.34, delta: 0.24 },
      { span: '21:0-24:0', beforeBuy: 0.1, afterBuy: 0.12, delta: 0.02 },
    ]);

    // Gap interval preserves full candidate schedule with null before.
    expect(preview.affectedIntervals[1].before).toBeNull();
    expect(preview.affectedIntervals[1].after?.source).toBe('estimated');
    expect(preview.affectedIntervals[1].seasons).toHaveLength(1);
    expect(preview.affectedIntervals[1].seasons[0].beforeSeasonName).toBeNull();
    expect(preview.affectedIntervals[1].seasons[0].afterSeasonName).toBe('Summer');

    // Both replaced Tesla intervals preserve their originals (with version metadata).
    expect(preview.restoration.preservedOriginals).toEqual([
      {
        originalSelectionId: null,
        tariffId: 101,
        name: 'Tesla Rg2 2024',
        version: 1,
        contentHash: 'hash-a',
        effectiveFrom: '2025-03-01',
        effectiveTo: '2025-05-31',
      },
      {
        originalSelectionId: null,
        tariffId: 102,
        name: 'Tesla Rg2 2025',
        version: 2,
        contentHash: 'hash-b',
        effectiveFrom: '2025-07-01',
        effectiveTo: '2025-09-30',
      },
    ]);

    // Unchanged outside periods keep untouched 2024 plan plus trimmed remnants of A and B.
    expect(preview.unchangedOutsidePeriods.map(u => ({
      from: u.effectiveFrom,
      to: u.effectiveTo,
      name: u.plan.name,
      relation: u.relation,
      wasTrimmed: u.wasTrimmed,
    }))).toEqual([
      { from: '2024-01-01', to: '2024-12-31', name: 'Tesla 2023 Plan', relation: 'before_range', wasTrimmed: false },
      { from: '2025-01-01', to: '2025-02-28', name: 'Tesla Rg2 2024', relation: 'before_range', wasTrimmed: true },
      { from: '2025-10-01', to: null, name: 'Tesla Rg2 2025', relation: 'after_range', wasTrimmed: true },
    ]);

    expect(preview.summary.fillsGap).toBe(true);
    expect(preview.summary.replacesExistingPlan).toBe(true);
  });

  it('treats effectiveTo as an inclusive end date including single-day bounded replacements and exact boundary touching', () => {
    const existing = makePlanSnapshot({
      tariffId: 201,
      version: 1,
      periodId: 21,
      name: 'Existing Plan',
      source: 'tesla',
      seasons: summerWinterPlanA,
    });
    const manual = makePlanSnapshot({
      name: 'One Day Override',
      source: 'manual',
      seasons: shiftedWindowPlanB,
    });

    const singleDay = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'manual', name: 'One Day Override', seasons: shiftedWindowPlanB },
        effectiveFrom: '2025-06-15',
        effectiveTo: '2025-06-15',
      },
      existingSpans: [
        { effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', plan: existing },
      ],
      candidatePlan: manual,
    });

    expect(singleDay.affectedIntervals).toHaveLength(1);
    expect(singleDay.affectedIntervals[0].effectiveFrom).toBe('2025-06-15');
    expect(singleDay.affectedIntervals[0].effectiveTo).toBe('2025-06-15');
    expect(singleDay.unchangedOutsidePeriods.map(u => [u.effectiveFrom, u.effectiveTo, u.relation])).toEqual([
      ['2025-01-01', '2025-06-14', 'before_range'],
      ['2025-06-16', '2025-12-31', 'after_range'],
    ]);

    // Touching only the last day of span 1 and the first day of span 2 across a gap.
    const nextExisting = makePlanSnapshot({
      tariffId: 202,
      version: 2,
      periodId: 22,
      name: 'Next Plan',
      source: 'tesla',
      seasons: summerWinterPlanA,
    });
    const edgeTouch = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'manual', name: 'Bridge', seasons: shiftedWindowPlanB },
        effectiveFrom: '2025-05-31',
        effectiveTo: '2025-07-01',
      },
      existingSpans: [
        { effectiveFrom: '2025-01-01', effectiveTo: '2025-05-31', plan: existing },
        { effectiveFrom: '2025-07-01', effectiveTo: '2025-12-31', plan: nextExisting },
      ],
      candidatePlan: manual,
    });

    expect(edgeTouch.affectedIntervals.map(i => [i.effectiveFrom, i.effectiveTo, i.kind])).toEqual([
      ['2025-05-31', '2025-05-31', 'replace'],
      ['2025-06-01', '2025-06-30', 'fill_gap'],
      ['2025-07-01', '2025-07-01', 'replace'],
    ]);
    expect(edgeTouch.unchangedOutsidePeriods.map(u => [u.effectiveFrom, u.effectiveTo, u.wasTrimmed])).toEqual([
      ['2025-01-01', '2025-05-30', true],
      ['2025-07-02', '2025-12-31', true],
    ]);
  });

  it('handles ongoing ranges (effectiveTo: null) extending past a bounded plan into an ongoing gap and empty timelines', () => {
    const bounded = makePlanSnapshot({
      tariffId: 301,
      version: 1,
      periodId: 31,
      name: 'Bounded Estimate',
      source: 'estimated',
      choiceKind: 'automatic',
      seasons: summerWinterPlanA,
    });
    const candidate = makePlanSnapshot({
      name: 'Ongoing Manual',
      source: 'manual',
      seasons: shiftedWindowPlanB,
    });

    const preview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'manual', name: 'Ongoing Manual', seasons: shiftedWindowPlanB },
        effectiveFrom: '2025-04-01',
        effectiveTo: null,
      },
      existingSpans: [
        { effectiveFrom: '2025-01-01', effectiveTo: '2025-06-30', plan: bounded },
      ],
      candidatePlan: candidate,
    });

    expect(preview.effectiveTo).toBeNull();
    expect(preview.recalculationRange).toEqual({ fromDate: '2025-04-01', toDate: null });
    expect(preview.affectedIntervals.map(i => [i.effectiveFrom, i.effectiveTo, i.kind])).toEqual([
      ['2025-04-01', '2025-06-30', 'replace'],
      ['2025-07-01', null, 'fill_gap'],
    ]);
    // Ongoing tail interval covers the full canonical year (2 seasons for candidate).
    expect(preview.affectedIntervals[1].seasons.map(s => s.afterSeasonName)).toEqual(['Summer', 'Winter']);
    expect(preview.unchangedOutsidePeriods.map(u => [u.effectiveFrom, u.effectiveTo])).toEqual([
      ['2025-01-01', '2025-03-31'],
    ]);

    // Empty timeline (pure gap fill)
    const emptyTimeline = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'manual', name: 'Ongoing Manual', seasons: shiftedWindowPlanB },
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
      },
      existingSpans: [],
      candidatePlan: candidate,
    });

    expect(emptyTimeline.affectedIntervals).toHaveLength(1);
    expect(emptyTimeline.affectedIntervals[0].kind).toBe('fill_gap');
    expect(emptyTimeline.unchangedOutsidePeriods).toEqual([]);
    expect(emptyTimeline.summary.fillsGap).toBe(true);
    expect(emptyTimeline.summary.replacesExistingPlan).toBe(false);
  });

  it('never recalculates actual history for reference-scope selections or future-only actual selections', () => {
    const refPlan = makePlanSnapshot({
      tariffId: 401,
      version: 1,
      periodId: 41,
      name: 'Fixed Baseline',
      source: 'estimated',
      choiceKind: 'automatic',
      seasons: summerWinterPlanA,
    });
    const newRef = makePlanSnapshot({
      name: 'Updated Fixed Baseline',
      source: 'manual',
      seasons: shiftedWindowPlanB,
    });

    const refPreview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'reference',
        candidate: { kind: 'manual', name: 'Updated Fixed Baseline', seasons: shiftedWindowPlanB },
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
      },
      existingSpans: [
        { effectiveFrom: '2025-01-01', effectiveTo: null, plan: refPlan },
      ],
      candidatePlan: newRef,
    });

    expect(refPreview.scope).toBe('reference');
    expect(refPreview.recalculatesHistory).toBe(false);
    expect(refPreview.recalculationRange).toBeNull();

    const futureActualPreview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'manual', name: 'Future Rate', seasons: shiftedWindowPlanB },
        effectiveFrom: '2027-01-01',
        effectiveTo: null,
      },
      existingSpans: [
        { effectiveFrom: '2025-01-01', effectiveTo: null, plan: refPlan },
      ],
      candidatePlan: newRef,
    });

    expect(futureActualPreview.recalculatesHistory).toBe(false);
    expect(futureActualPreview.recalculationRange).toBeNull();
  });

  it('carries forward preserved Tesla originals when overriding an existing override', () => {
    const priorOverride = makePlanSnapshot({
      tariffId: 500,
      version: 1,
      periodId: 50,
      selectionId: 90,
      name: 'Prior Public Override',
      source: 'estimated',
      choiceKind: 'owner',
      seasons: shiftedWindowPlanB,
    });
    const newManual = makePlanSnapshot({
      name: 'Second Override',
      source: 'manual',
      seasons: summerWinterPlanA,
    });

    const preview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'manual', name: 'Second Override', seasons: summerWinterPlanA },
        effectiveFrom: '2025-04-01',
        effectiveTo: '2025-08-31',
      },
      existingSpans: [
        {
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
          plan: priorOverride,
          preservedTeslaOriginal: {
            originalSelectionId: 90,
            tariffId: 101,
            name: 'Original Tesla Rg2',
            version: 1,
            contentHash: 'tesla-orig-hash',
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
          },
        },
      ],
      candidatePlan: newManual,
    });

    expect(preview.restoration.preservedOriginals).toEqual([
      {
        originalSelectionId: 90,
        tariffId: 101,
        name: 'Original Tesla Rg2',
        version: 1,
        contentHash: 'tesla-orig-hash',
        effectiveFrom: '2025-04-01',
        effectiveTo: '2025-08-31',
      },
    ]);
  });

  it('splits restoration previews across multiple saved Tesla originals and marks intervals without a saved original as unavailable', () => {
    const activeOverride = makePlanSnapshot({
      tariffId: 500,
      version: 1,
      periodId: 50,
      selectionId: 90,
      name: 'Public Override',
      source: 'estimated',
      choiceKind: 'owner',
      seasons: shiftedWindowPlanB,
    });
    const teslaV1 = makePlanSnapshot({
      tariffId: 101,
      version: 1,
      name: 'Tesla Original v1',
      source: 'tesla',
      contentHash: 'tesla-v1',
      seasons: summerWinterPlanA,
    });
    const teslaV2 = makePlanSnapshot({
      tariffId: 102,
      version: 2,
      name: 'Tesla Original v2',
      source: 'tesla',
      contentHash: 'tesla-v2',
      seasons: summerWinterPlanA,
    });

    const preview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'restore_tesla', originalSelectionId: 90 },
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-12-31',
      },
      existingSpans: [
        { effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', plan: activeOverride },
      ],
      restorationTargets: [
        {
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-05-31',
          original: {
            originalSelectionId: 90,
            tariffId: 101,
            name: 'Tesla Original v1',
            version: 1,
            contentHash: 'tesla-v1',
            effectiveFrom: '2025-01-01',
            effectiveTo: '2025-05-31',
          },
          plan: teslaV1,
        },
        // 2025-06-01 .. 2025-06-30 had no Tesla original
        {
          effectiveFrom: '2025-07-01',
          effectiveTo: '2025-12-31',
          original: {
            originalSelectionId: 90,
            tariffId: 102,
            name: 'Tesla Original v2',
            version: 2,
            contentHash: 'tesla-v2',
            effectiveFrom: '2025-07-01',
            effectiveTo: '2025-12-31',
          },
          plan: teslaV2,
        },
      ],
    });

    expect(preview.affectedIntervals.map(i => ({
      from: i.effectiveFrom,
      to: i.effectiveTo,
      kind: i.kind,
      afterName: i.after?.name ?? null,
      restorationStatus: i.restoration.status,
    }))).toEqual([
      { from: '2025-01-01', to: '2025-05-31', kind: 'restore', afterName: 'Tesla Original v1', restorationStatus: 'restoring_original' },
      { from: '2025-06-01', to: '2025-06-30', kind: 'restore_unavailable', afterName: null, restorationStatus: 'unavailable' },
      { from: '2025-07-01', to: '2025-12-31', kind: 'restore', afterName: 'Tesla Original v2', restorationStatus: 'restoring_original' },
    ]);

    expect(preview.candidatePlan).toBeNull();
    expect(preview.restoration.canApplyRestoration).toBe(true);
    expect(preview.restoration.restoredOriginals).toHaveLength(2);
    expect(preview.restoration.unavailableRanges).toHaveLength(1);
    expect(preview.restoration.unavailableRanges[0]).toMatchObject({
      effectiveFrom: '2025-06-01',
      effectiveTo: '2025-06-30',
    });

    // When no Tesla original exists at all, restoration cannot be applied and does not recalculate history.
    const noOriginalPreview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'restore_tesla', originalSelectionId: 90 },
        effectiveFrom: '2025-06-01',
        effectiveTo: '2025-06-30',
      },
      existingSpans: [
        { effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', plan: activeOverride },
      ],
      restorationTargets: [],
    });

    expect(noOriginalPreview.restoration.canApplyRestoration).toBe(false);
    expect(noOriginalPreview.recalculatesHistory).toBe(false);
    expect(noOriginalPreview.recalculationRange).toBeNull();
    expect(noOriginalPreview.affectedIntervals[0].kind).toBe('restore_unavailable');
    expect(noOriginalPreview.affectedIntervals[0].after).toBeNull();
  });
});

describe('rate and schedule comparison accuracy', () => {
  const allYearBase: TariffSeasonInput[] = [
    {
      name: 'All Year',
      fromMonth: 1,
      toMonth: 12,
      weekdayPeriods: [
        { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
        { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.3, sellRate: 0.05 },
        { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
      ],
      weekendPeriods: [
        { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
      ],
    },
  ];

  it('recognizes different period names with identical buy and sell rates as zero rate change', () => {
    const renamedSameRates: TariffSeasonInput[] = [
      {
        name: 'Year Round',
        fromMonth: 1,
        toMonth: 12,
        weekdayPeriods: [
          { touName: 'SUPER_OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
          { touName: 'PARTIAL_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.3, sellRate: 0.05 },
          { touName: 'SUPER_OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
        ],
        weekendPeriods: [
          { touName: 'SUPER_OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
        ],
      },
    ];

    const comparison = compareTariffSchedules(allYearBase, renamedSameRates);
    expect(comparison.hasBuyRateChanges).toBe(false);
    expect(comparison.hasSellRateChanges).toBe(false);
    expect(comparison.hasRateChanges).toBe(false);
    expect(comparison.hasPeriodNameChanges).toBe(true);

    const preview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'manual', name: 'Renamed', seasons: renamedSameRates },
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
      },
      existingSpans: [
        {
          effectiveFrom: '2025-01-01',
          effectiveTo: null,
          plan: makePlanSnapshot({ tariffId: 1, version: 1, name: 'Base', source: 'tesla', seasons: allYearBase }),
        },
      ],
      candidatePlan: makePlanSnapshot({ name: 'Renamed', source: 'manual', seasons: renamedSameRates }),
    });

    expect(preview.summary.hasRateChanges).toBe(false);
    expect(preview.summary.hasBuyRateChanges).toBe(false);
    expect(preview.summary.hasSellRateChanges).toBe(false);
    expect(preview.summary.hasPeriodNameChanges).toBe(true);
    for (const row of preview.affectedIntervals[0].seasons[0].weekdayRows) {
      expect(row.buyRateDelta).toBe(0);
      expect(row.sellRateDelta).toBe(0);
      expect(row.rateChanged).toBe(false);
      expect(row.periodNameChanged).toBe(true);
    }
  });

  it('detects buy-rate differences when period names and windows are identical', () => {
    const higherBuySameNames: TariffSeasonInput[] = [
      {
        name: 'All Year',
        fromMonth: 1,
        toMonth: 12,
        weekdayPeriods: [
          { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
          { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.35, sellRate: 0.05 },
          { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
        ],
        weekendPeriods: [
          { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.04 },
        ],
      },
    ];

    const comparison = compareTariffSchedules(allYearBase, higherBuySameNames);
    expect(comparison.hasBuyRateChanges).toBe(true);
    expect(comparison.hasSellRateChanges).toBe(false);
    expect(comparison.hasRateChanges).toBe(true);
    expect(comparison.hasPeriodNameChanges).toBe(false);

    const peakRow = comparison.seasons[0].weekdayRows[1];
    expect(peakRow.before?.touName).toBe('ON_PEAK');
    expect(peakRow.after?.touName).toBe('ON_PEAK');
    expect(peakRow.buyRateDelta).toBe(0.05);
    expect(peakRow.sellRateDelta).toBe(0);
    expect(peakRow.buyRateChanged).toBe(true);
    expect(peakRow.sellRateChanged).toBe(false);
    expect(peakRow.periodNameChanged).toBe(false);
  });

  it('detects export-price (sell rate) differences even when buy rates and period names match', () => {
    const lowerExportSameBuy: TariffSeasonInput[] = [
      {
        name: 'All Year',
        fromMonth: 1,
        toMonth: 12,
        weekdayPeriods: [
          { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.12, sellRate: 0.02 },
          { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.3, sellRate: 0.02 },
          { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.02 },
        ],
        weekendPeriods: [
          { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.02 },
        ],
      },
    ];

    const preview = buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual',
        candidate: { kind: 'manual', name: 'Lower Export', seasons: lowerExportSameBuy },
        effectiveFrom: '2025-01-01',
        effectiveTo: '2025-12-31',
      },
      existingSpans: [
        {
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
          plan: makePlanSnapshot({ tariffId: 1, version: 1, name: 'Base', source: 'tesla', seasons: allYearBase }),
        },
      ],
      candidatePlan: makePlanSnapshot({ name: 'Lower Export', source: 'manual', seasons: lowerExportSameBuy }),
    });

    expect(preview.summary.hasBuyRateChanges).toBe(false);
    expect(preview.summary.hasSellRateChanges).toBe(true);
    expect(preview.summary.hasRateChanges).toBe(true);
    expect(preview.summary.hasPeriodNameChanges).toBe(false);
    expect(preview.affectedIntervals[0].seasons[0].weekdayRows[1].sellRateDelta).toBe(-0.03);
    expect(preview.affectedIntervals[0].seasons[0].weekendRows[0].sellRateDelta).toBe(-0.02);
  });

  it('splits cleanly at midnight-crossing windows, minute-level boundaries, and mid-month Tesla seasons', () => {
    const midnightCrossingAndMidMonth: TariffSeasonInput[] = [
      {
        name: 'Main Year',
        fromMonth: 9,
        fromDay: 11,
        toMonth: 9,
        toDay: 7,
        weekdayPeriods: [
          { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 8, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
          { touName: 'ON_PEAK', fromHour: 8, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.3, sellRate: 0.04 },
        ],
        weekendPeriods: [
          { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.03 },
        ],
      },
      {
        name: 'Short Sep Window',
        fromMonth: 9,
        fromDay: 8,
        toMonth: 9,
        toDay: 10,
        weekdayPeriods: [
          { touName: 'ON_PEAK', fromHour: 0, fromMinute: 0, toHour: 6, toMinute: 7, buyRate: 0.4, sellRate: 0.05 },
          { touName: 'OFF_PEAK', fromHour: 6, fromMinute: 7, toHour: 24, toMinute: 0, buyRate: 0.15, sellRate: 0.03 },
        ],
        weekendPeriods: [
          { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.15, sellRate: 0.03 },
        ],
      },
    ];

    const aligned = compareTariffSeasons(midnightCrossingAndMidMonth, allYearBase);
    expect(aligned.map(s => `${s.fromMonth}/${s.fromDay}-${s.toMonth}/${s.toDay}:${s.beforeSeasonName}`)).toEqual([
      '9/8-9/10:Short Sep Window',
      '9/11-9/7:Main Year',
    ]);

    // Short Sep Window splits at 06:07, 08:00, and 20:00.
    expect(aligned[0].weekdayRows.map(r => `${r.fromHour}:${r.fromMinute}-${r.toHour}:${r.toMinute}`)).toEqual([
      '0:0-6:7',
      '6:7-8:0',
      '8:0-20:0',
      '20:0-24:0',
    ]);
    // Main Year midnight-crossing 20:00..08:00 matches 00:00..08:00 and 20:00..24:00.
    expect(aligned[1].weekdayRows.map(r => [r.fromHour, r.toHour, r.before?.buyRate])).toEqual([
      [0, 8, 0.1],
      [8, 20, 0.3],
      [20, 24, 0.1],
    ]);
  });
});

describe('strict date & request validation and reviewHash determinism', () => {
  it('rejects every form of missing, empty, implicit, or out-of-bounds effective dates', () => {
    const today = '2026-11-17';
    // Missing or empty effectiveFrom
    expect(() => validateSelectionDates(undefined, null, today)).toThrow(TariffValidationError);
    expect(() => validateSelectionDates(null, null, today)).toThrow(TariffValidationError);
    expect(() => validateSelectionDates('', null, today)).toThrow(TariffValidationError);
    expect(() => validateSelectionDates('   ', null, today)).toThrow(TariffValidationError);

    // Missing or empty effectiveTo (must be explicit date or explicit null)
    expect(() => validateSelectionDates('2025-01-01', undefined, today)).toThrow(TariffValidationError);
    expect(() => validateSelectionDates('2025-01-01', '', today)).toThrow(TariffValidationError);
    expect(() => validateSelectionDates('2025-01-01', '   ', today)).toThrow(TariffValidationError);

    // Invalid calendar dates or inverted range or out-of-bounds
    expect(() => validateSelectionDates('2025-02-29', null, today)).toThrow(TariffValidationError);
    expect(() => validateSelectionDates('2025-05-01', '2025-04-30', today)).toThrow(TariffValidationError);
    expect(() => validateSelectionDates('2014-12-31', null, today)).toThrow(TariffValidationError);
    expect(() => validateSelectionDates('2027-11-18', null, today)).toThrow(TariffValidationError);

    // Request object missing effectiveTo key altogether
    expect(() => validateTariffSelectionRequest({
      scope: 'actual',
      candidate: { kind: 'public', label: 'urdb-1' },
      effectiveFrom: '2025-01-01',
    }, today)).toThrow(TariffValidationError);

    // Public candidate with revisionStart never fills missing effectiveFrom
    const publicPlanWithRevision = makePlanSnapshot({
      name: 'Public Plan',
      source: 'estimated',
      urdbLabel: 'urdb-1',
      revisionStart: '2025-01-01',
      seasons: summerWinterPlanA,
    });
    expect(() => buildTariffSelectionPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: today,
      request: {
        scope: 'actual',
        candidate: { kind: 'public', label: 'urdb-1' },
        effectiveFrom: '',
        effectiveTo: null,
      },
      existingSpans: [],
      candidatePlan: publicPlanWithRevision,
    })).toThrow(TariffValidationError);
  });

  it('prevents clients from supplying invented rates for public or restoration candidates and rejects malformed payloads', () => {
    const today = '2026-11-17';

    expect(() => validateTariffSelectionRequest({
      scope: 'actual',
      candidate: { kind: 'public', label: 'urdb-1', seasons: summerWinterPlanA },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
    }, today)).toThrow(TariffValidationError);

    expect(() => validateTariffSelectionRequest({
      scope: 'actual',
      candidate: { kind: 'restore_tesla', originalSelectionId: 5, seasons: summerWinterPlanA },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
    }, today)).toThrow(TariffValidationError);

    expect(() => validateTariffSelectionRequest({
      scope: 'actual',
      candidate: { kind: 'restore_tesla', originalSelectionId: 0 },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
    }, today)).toThrow(TariffValidationError);

    expect(() => validateTariffSelectionRequest({
      scope: 'actual',
      candidate: { kind: 'manual', name: 'Bad Seasons', seasons: [null] },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
    }, today)).toThrow(TariffValidationError);

    expect(() => validateTariffSelectionCommit({
      scope: 'actual',
      candidate: { kind: 'public', label: 'urdb-1' },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      expectedReviewHash: 'abc123',
      verifiedAgainstBill: 'yes',
    }, today)).toThrow(TariffValidationError);

    const validCommit = validateTariffSelectionCommit({
      scope: 'reference',
      candidate: { kind: 'public', label: '  urdb-1  ' },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      expectedReviewHash: 'abc123',
      verifiedAgainstBill: false,
    }, today);
    expect(validCommit).toEqual({
      scope: 'reference',
      candidate: { kind: 'public', label: 'urdb-1' },
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      expectedReviewHash: 'abc123',
      verifiedAgainstBill: false,
    });
  });

  it('produces a deterministic reviewHash invariant to input ordering and sensitive to site, scope, rates, eligibility, and conversion inputs', () => {
    const planA = makePlanSnapshot({
      tariffId: 101,
      version: 1,
      name: 'Tesla A',
      source: 'tesla',
      seasons: summerWinterPlanA,
    });
    const planAReversed = makePlanSnapshot({
      tariffId: 101,
      version: 1,
      name: 'Tesla A',
      source: 'tesla',
      seasons: [...summerWinterPlanA].reverse(),
    });
    const candidate = makePlanSnapshot({
      name: 'Public B',
      source: 'estimated',
      urdbLabel: 'urdb-b',
      seasons: shiftedWindowPlanB,
    });

    const baseInput = {
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-17',
      request: {
        scope: 'actual' as const,
        candidate: { kind: 'public' as const, label: 'urdb-b' },
        effectiveFrom: '2025-03-01',
        effectiveTo: '2025-09-30',
      },
      existingSpans: [{ effectiveFrom: '2025-01-01', effectiveTo: null, plan: planA }],
      candidatePlan: candidate,
      eligibility: 'us',
      conversionInputs: { medianMonthlyKwh: 850, fallbackSellRate: 0.03 },
    };

    const p1 = buildTariffSelectionPreview(baseInput);
    const p2 = buildTariffSelectionPreview({
      ...baseInput,
      existingSpans: [{ effectiveFrom: '2025-01-01', effectiveTo: null, plan: planAReversed }],
      conversionInputs: { fallbackSellRate: 0.03, medianMonthlyKwh: 850 },
    });
    expect(p1.reviewHash).toBe(p2.reviewHash);

    const differentSite = buildTariffSelectionPreview({ ...baseInput, siteId: 'site-2' });
    const differentEligibility = buildTariffSelectionPreview({ ...baseInput, eligibility: 'outside_us' });
    const differentConversion = buildTariffSelectionPreview({
      ...baseInput,
      conversionInputs: { medianMonthlyKwh: 900, fallbackSellRate: 0.03 },
    });
    const differentScope = buildTariffSelectionPreview({
      ...baseInput,
      request: { ...baseInput.request, scope: 'reference' },
    });

    expect(differentSite.reviewHash).not.toBe(p1.reviewHash);
    expect(differentEligibility.reviewHash).not.toBe(p1.reviewHash);
    expect(differentConversion.reviewHash).not.toBe(p1.reviewHash);
    expect(differentScope.reviewHash).not.toBe(p1.reviewHash);
  });
});
