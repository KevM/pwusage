import { describe, expect, it } from 'vitest';
import type { RollupBackfill } from '@/lib/db';
import type { RoiSummary } from './roi-service';
import { isBackfillInProcess, isTerminalBackfillError, selectSavingsViewState } from './savings-status';

const bf = (over: Partial<RollupBackfill>): RollupBackfill => ({
  site_id: 's1', status: 'pending', oldest_date: '2024-01-01', cursor_date: '2024-01-01',
  newest_date: '2024-06-01', days_done: 0, days_total: 100, genesis_anchored: false, last_error: null,
  ...over,
});

const summary = {} as RoiSummary;

describe('isBackfillInProcess', () => {
  it('is false when there is no backfill row', () => {
    expect(isBackfillInProcess(null)).toBe(false);
  });
  it('treats pending, running and error as in process', () => {
    expect(isBackfillInProcess(bf({ status: 'pending' }))).toBe(true);
    expect(isBackfillInProcess(bf({ status: 'running' }))).toBe(true);
    expect(isBackfillInProcess(bf({ status: 'error' }))).toBe(true);
  });
  it('is false once complete', () => {
    expect(isBackfillInProcess(bf({ status: 'complete' }))).toBe(false);
  });
});

describe('isTerminalBackfillError', () => {
  it('is false for non-error statuses', () => {
    expect(isTerminalBackfillError(bf({ status: 'running' }))).toBe(false);
    expect(isTerminalBackfillError(null)).toBe(false);
  });
  it('is false for a recoverable error below 5 attempts', () => {
    expect(isTerminalBackfillError(bf({ status: 'error', last_error: '[attempts=3] 529 overload' }))).toBe(false);
  });
  it('is true once attempts reach 5 (cron stops reclaiming)', () => {
    expect(isTerminalBackfillError(bf({ status: 'error', last_error: '[attempts=5] 529 overload' }))).toBe(true);
  });
  it('is false for an error with no attempt prefix', () => {
    expect(isTerminalBackfillError(bf({ status: 'error', last_error: 'boom' }))).toBe(false);
  });
});

describe('selectSavingsViewState', () => {
  it('returns in-process whenever the backfill is working, even on error', () => {
    expect(selectSavingsViewState(summary, bf({ status: 'error' }))).toBe('in-process');
    expect(selectSavingsViewState(null, bf({ status: 'running' }))).toBe('in-process');
  });
  it('returns setup when nothing is configured and nothing is running', () => {
    expect(selectSavingsViewState(null, null)).toBe('setup');
    expect(selectSavingsViewState(null, bf({ status: 'complete' }))).toBe('setup');
  });
  it('returns configured when a summary exists and nothing is running', () => {
    expect(selectSavingsViewState(summary, null)).toBe('configured');
    expect(selectSavingsViewState(summary, bf({ status: 'complete' }))).toBe('configured');
  });
});
