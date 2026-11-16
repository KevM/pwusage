import { describe, expect, it } from 'vitest';
import { askDate, historyWindow, type HistoryWindowInput } from './history-window';

const today = '2026-11-16';
const base: HistoryWindowInput = { today, historyStart: '2023-11-14', earliestTesla: null, manualSpans: [] };

describe('historyWindow', () => {
  it('harrisonWindowEndsBeforeFirstSeen', () => {
    const window = historyWindow({ ...base, earliestTesla: { firstSeen: '2026-04-28', anchorStart: '2023-11-14', anchorSource: 'history_start' } });
    expect(window).toMatchObject({ historyStart: '2023-11-14', fillThrough: '2026-04-27', askYears: [2025, 2024, 2023] });
    expect(window?.unconfirmedDays).toBe(896);
  });
  it('matchedAnchorIsTheTrustedStart', () => {
    const window = historyWindow({ ...base, earliestTesla: { firstSeen: '2026-04-28', anchorStart: '2025-06-01', anchorSource: 'urdb' } });
    expect(window?.fillThrough).toBe('2025-05-31');
    expect(window?.askYears).toEqual([2024, 2023]);
  });
  it('noTeslaFillsThroughToday', () => {
    const window = historyWindow(base);
    expect(window?.fillThrough).toBeNull();
    expect(window?.askYears).toEqual([2025, 2024, 2023]);
  });
  it('shortHistoryIsNotOffered', () => {
    expect(historyWindow({ ...base, historyStart: '2025-11-18' })).toBeNull();
    expect(historyWindow({ ...base, historyStart: '2025-11-16' })).not.toBeNull();
    expect(historyWindow({ ...base, historyStart: null })).toBeNull();
  });
  it('manualCoverageSkipsYearsAndCanEndTheOffer', () => {
    const skipped = historyWindow({ ...base, manualSpans: [{ from: '2024-01-01', to: '2024-12-31' }] });
    expect(skipped?.askYears).toEqual([2025, 2023]);
    const covered = historyWindow({ ...base, manualSpans: [{ from: '2023-01-01', to: null }] });
    expect(covered).toBeNull();
    const nearlyCovered = historyWindow({ ...base, manualSpans: [{ from: '2023-11-14', to: '2026-10-20' }] });
    expect(nearlyCovered).toBeNull();
  });
  it('askDateClampsToTheWindow', () => {
    const window = historyWindow({ ...base, earliestTesla: { firstSeen: '2026-04-28', anchorStart: null, anchorSource: null } })!;
    expect(askDate(2023, window, today)).toBe('2023-11-14');
    expect(askDate(2024, window, today)).toBe('2024-07-01');
    expect(askDate(2026, window, today)).toBe('2026-04-27');
    expect(askDate(2026, historyWindow(base)!, today)).toBe('2026-07-01');
    expect(askDate(2027, historyWindow(base)!, today)).toBe(today);
  });
});
