import type { RollupBackfill } from '@/lib/db';
import type { RoiSummary } from './roi-service';

export type SavingsViewState = 'in-process' | 'setup' | 'configured';

/**
 * A backfill row that exists and has not completed is still being worked: the
 * index-history cron's claimNext() reclaims stale `running` and `error` rows
 * (up to 5 attempts). So `error` is in process, NOT "not started".
 */
export function isBackfillInProcess(backfill: RollupBackfill | null): boolean {
  return backfill != null && backfill.status !== 'complete';
}

/**
 * The cron stops reclaiming an `error` row once it reaches 5 attempts
 * (last_error like `[attempts=5]…`). At that point it is genuinely paused.
 */
export function isTerminalBackfillError(backfill: RollupBackfill | null): boolean {
  if (!backfill || backfill.status !== 'error') return false;
  const match = backfill.last_error?.match(/^\[attempts=(\d+)\]/);
  return match ? parseInt(match[1], 10) >= 5 : false;
}

export function selectSavingsViewState(
  summary: RoiSummary | null,
  backfill: RollupBackfill | null,
): SavingsViewState {
  if (isBackfillInProcess(backfill)) return 'in-process';
  if (!summary) return 'setup';
  return 'configured';
}
