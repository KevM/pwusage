import { describe, expect, it } from 'vitest';
import { layoutTimeline } from './tariff-estimates';
import type { ExistingSpan } from './tariff-timeline';

const span = (id: number, tariffId: number, source: ExistingSpan['source'], effectiveFrom: string, effectiveTo: string | null, updatedByUserId: string | null = null): ExistingSpan => ({ id, tariffId, source, effectiveFrom, effectiveTo, updatedByUserId });

describe('layoutTimeline', () => {
  it('fills gaps around owner plans without overwriting them', () => {
    const result = layoutTimeline([span(1, 10, 'manual', '2025-01-10', '2025-01-20', 'owner')], [], [{ tariffId: 20, effectiveFrom: '2025-01-01', effectiveTo: '2025-01-31' }]);
    expect(result.inserts).toEqual([
      { tariffId: 20, source: 'estimated', effectiveFrom: '2025-01-01', effectiveTo: '2025-01-09', updatedByUserId: null },
      { tariffId: 20, source: 'estimated', effectiveFrom: '2025-01-21', effectiveTo: '2025-01-31', updatedByUserId: null },
    ]);
  });
  it('does not move owner-dated Tesla plans', () => {
    const original = span(1, 10, 'tesla', '2025-01-10', null, 'owner');
    const result = layoutTimeline([original], [{ tariffId: 10, startDate: '2025-01-01' }], []);
    expect(result.deleteIds).toEqual([]);
    expect(result.inserts).toEqual([]);
  });
  it('does not move Tesla later if an estimate leaves a gap', () => {
    const original = span(1, 10, 'tesla', '2025-01-01', null);
    const result = layoutTimeline([original], [{ tariffId: 10, startDate: '2025-01-10' }], [{ tariffId: 20, effectiveFrom: '2025-01-02', effectiveTo: '2025-01-09' }]);
    expect(result.deleteIds).toEqual([]);
    expect(result.inserts).toEqual([]);
  });
  it('moves a Tesla plan earlier across estimates and reports only changed days', () => {
    const result = layoutTimeline([
      span(1, 20, 'estimated', '2025-01-01', '2025-01-09'),
      span(2, 10, 'tesla', '2025-01-10', null),
    ], [{ tariffId: 10, startDate: '2025-01-05' }], [{ tariffId: 20, effectiveFrom: '2025-01-01', effectiveTo: '2025-01-09' }]);
    expect(result.inserts).toContainEqual({ tariffId: 10, source: 'tesla', effectiveFrom: '2025-01-05', effectiveTo: null, updatedByUserId: null });
    expect(result.changed).toEqual([{ from: '2025-01-05', to: '2025-01-09' }]);
  });
  it('moves multiple Tesla anchors earlier without losing updates to later spans', () => {
    const result = layoutTimeline([
      span(1, 10, 'tesla', '2025-01-10', '2025-01-19'),
      span(2, 20, 'tesla', '2025-01-20', '2025-01-29'),
      span(3, 30, 'tesla', '2025-01-30', null),
    ], [
      { tariffId: 10, startDate: '2025-01-05' },
      { tariffId: 20, startDate: '2025-01-15' },
      { tariffId: 30, startDate: '2025-01-30' },
    ], [
      { tariffId: 90, effectiveFrom: '2025-01-01', effectiveTo: '2025-01-04' },
      { tariffId: 91, effectiveFrom: '2025-01-10', effectiveTo: '2025-01-14' },
      { tariffId: 92, effectiveFrom: '2025-01-20', effectiveTo: '2025-01-29' },
    ]);
    expect(result.inserts).toContainEqual({
      tariffId: 10, source: 'tesla', effectiveFrom: '2025-01-05', effectiveTo: '2025-01-14', updatedByUserId: null,
    });
    expect(result.inserts).toContainEqual({
      tariffId: 20, source: 'tesla', effectiveFrom: '2025-01-15', effectiveTo: '2025-01-29', updatedByUserId: null,
    });
  });
  it('moves later only when desired estimates cover every freed day', () => {
    const result = layoutTimeline([span(1, 10, 'tesla', '2025-01-01', null)], [{ tariffId: 10, startDate: '2025-01-10' }], [{ tariffId: 20, effectiveFrom: '2025-01-01', effectiveTo: '2025-01-09' }]);
    expect(result.inserts).toContainEqual({ tariffId: 10, source: 'tesla', effectiveFrom: '2025-01-10', effectiveTo: null, updatedByUserId: null });
    expect(result.changed).toEqual([{ from: '2025-01-01', to: '2025-01-09' }]);
  });
  it('is a no-op for an already laid-out timeline', () => {
    const existing = [span(1, 20, 'estimated', '2025-01-01', '2025-01-09'), span(2, 10, 'manual', '2025-01-10', null, 'owner')];
    expect(layoutTimeline(existing, [], [{ tariffId: 20, effectiveFrom: '2025-01-01', effectiveTo: null }])).toEqual({ deleteIds: [], inserts: [], changed: [] });
  });

  it('preserves owner-selected estimated plans across estimate rebuilds while filling uncovered gaps', () => {
    const ownerPublic = {
      ...span(1, 50, 'estimated', '2025-03-01', '2025-09-30', 'u1'),
      selectionId: 77,
      choiceKind: 'owner',
    } as ExistingSpan;
    const result = layoutTimeline(
      [ownerPublic],
      [],
      [{ tariffId: 99, effectiveFrom: '2025-01-01', effectiveTo: null }]
    );

    expect(result.deleteIds).toEqual([]);
    expect(result.inserts).toEqual([
      { tariffId: 99, source: 'estimated', effectiveFrom: '2025-01-01', effectiveTo: '2025-02-28', updatedByUserId: null },
      { tariffId: 99, source: 'estimated', effectiveFrom: '2025-10-01', effectiveTo: null, updatedByUserId: null },
    ]);
  });

  it('preserves owner-selected estimated plans even when desired estimates are empty (e.g. skipped utility)', () => {
    const ownerPublic = {
      ...span(1, 50, 'estimated', '2025-03-01', null, 'u1'),
      selectionId: 77,
      choiceKind: 'owner',
    } as ExistingSpan;
    const result = layoutTimeline([ownerPublic], [], []);
    expect(result).toEqual({ deleteIds: [], inserts: [], changed: [] });
  });

  it('does not move or trim restored saved Tesla spans when automatic Tesla anchors expand', () => {
    const restoredTesla = {
      ...span(1, 10, 'tesla', '2025-02-01', '2025-03-31', null),
      selectionId: 88,
      choiceKind: 'owner',
    } as ExistingSpan;
    const automaticTesla = {
      ...span(2, 12, 'tesla', '2025-04-01', null, null),
      selectionId: 89,
      choiceKind: 'automatic',
    } as ExistingSpan;

    const result = layoutTimeline(
      [restoredTesla, automaticTesla],
      [
        { tariffId: 10, startDate: '2025-01-01' },
        { tariffId: 12, startDate: '2025-01-15' },
      ],
      []
    );

    expect(result.deleteIds).toEqual([]);
    expect(result.inserts).toEqual([]);
  });

  it('preserves selectionId and choiceKind when automatic Tesla spans shift', () => {
    const autoEstimate = span(1, 20, 'estimated', '2025-01-01', '2025-01-09');
    const autoTesla = {
      ...span(2, 10, 'tesla', '2025-01-10', null, null),
      selectionId: 44,
      choiceKind: 'automatic',
    } as ExistingSpan;
    const result = layoutTimeline(
      [autoEstimate, autoTesla],
      [{ tariffId: 10, startDate: '2025-01-05' }],
      [{ tariffId: 20, effectiveFrom: '2025-01-01', effectiveTo: '2025-01-09' }]
    );

    expect(result.inserts).toContainEqual({
      tariffId: 10,
      source: 'tesla',
      effectiveFrom: '2025-01-05',
      effectiveTo: null,
      updatedByUserId: null,
      selectionId: 44,
      choiceKind: 'automatic',
    });
  });

});
