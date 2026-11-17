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

});
