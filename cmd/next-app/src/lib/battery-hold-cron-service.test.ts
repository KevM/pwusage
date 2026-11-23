import { describe, expect, it, vi } from 'vitest';
import type { BatteryHold } from './db';
import { DELIVERY_SEND_BUDGET_MS, type DeliverySummary } from './battery-hold-activity-delivery-service';
import { BATTERY_HOLD_CRON_BUDGET_MS, runBatteryHoldCron } from './battery-hold-cron-service';
import { MONITOR_SITE_BUDGET_MS, MONITOR_START_CUTOFF_MS } from './battery-hold-monitor-service';

// The monitor timing test's bound: one more site budget, lease release and reconcile past the cutoff.
const WORST_MONITOR_MS = MONITOR_START_CUTOFF_MS + MONITOR_SITE_BUDGET_MS + 4000;

const delivered = (overrides: Partial<DeliverySummary> = {}): DeliverySummary => ({
  status: 'ran', claimed: 1, accepted: 1, deferred: 0, disabled: 0, rejected: 0, released: 0,
  credentialFailure: null, runtimeMs: 5, ...overrides,
});
const monitored = { eligible: 1, attempted: 1, skipped: 0, failed: 0, completed: 1, activitiesSynced: 1, runtimeMs: 5, results: [] };
const hold = { id: 1, site_id: 's1' } as BatteryHold;

/** A clock that advances by `elapsedMs` while the monitor runs. */
function clock(elapsedMs: number) {
  let now = 1_000_000;
  return {
    now: () => now,
    monitor: vi.fn(async () => { now += elapsedMs; return monitored; }),
  };
}

describe('runBatteryHoldCron', () => {
  it('checks holds before delivering, so Apple can never delay a restore', async () => {
    const order: string[] = [];
    const result = await runBatteryHoldCron({
      loadHolds: async () => { order.push('load'); return [hold]; },
      monitor: async holds => { order.push(`monitor:${holds.length}`); return monitored; },
      deliver: async () => { order.push('deliver'); return delivered(); },
    });
    expect(order).toEqual(['load', 'monitor:1', 'deliver']);
    expect(result).toMatchObject({ monitor: monitored, delivery: delivered(), failed: false });
  });

  it('gives delivery its full send budget after a quick monitor run', async () => {
    const { now, monitor } = clock(3_000);
    const deliver = vi.fn(async () => delivered());
    await runBatteryHoldCron({ loadHolds: async () => [hold], monitor, deliver, now });
    expect(deliver).toHaveBeenCalledWith({ sendBudgetMs: DELIVERY_SEND_BUDGET_MS });
  });

  it('still delivers after a worst-case monitor run, with a send budget that ends inside the cap', async () => {
    const { now, monitor } = clock(WORST_MONITOR_MS);
    const deliver = vi.fn<(options: { sendBudgetMs: number }) => Promise<DeliverySummary>>(async () => delivered());
    await runBatteryHoldCron({ loadHolds: async () => [hold], monitor, deliver, now });
    const budget = deliver.mock.calls[0][0].sendBudgetMs;
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(DELIVERY_SEND_BUDGET_MS);
    expect(WORST_MONITOR_MS + budget).toBeLessThan(BATTERY_HOLD_CRON_BUDGET_MS);
  });

  it('leaves delivery to the next run when the monitor used up the budget', async () => {
    const { now, monitor } = clock(BATTERY_HOLD_CRON_BUDGET_MS);
    const deliver = vi.fn(async () => delivered());
    const result = await runBatteryHoldCron({ loadHolds: async () => [hold], monitor, deliver, now });
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivery: null, deliverySkipped: true, failed: false });
  });

  it('still delivers when the hold check fails, and reports the failure', async () => {
    const deliver = vi.fn(async () => delivered());
    const result = await runBatteryHoldCron({
      loadHolds: async () => { throw new Error('db down'); }, monitor: async () => monitored, deliver,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ monitor: null, monitorError: expect.any(Error), delivery: delivered(), failed: true });
  });

  it('reports a delivery failure or rejected APNs credentials without losing the monitor result', async () => {
    const thrown = await runBatteryHoldCron({
      loadHolds: async () => [hold], monitor: async () => monitored, deliver: async () => { throw new Error('apns'); },
    });
    expect(thrown).toMatchObject({ monitor: monitored, delivery: null, deliveryError: expect.any(Error), failed: true });
    const rejected = await runBatteryHoldCron({
      loadHolds: async () => [hold], monitor: async () => monitored,
      deliver: async () => delivered({ credentialFailure: 'InvalidProviderToken' }),
    });
    expect(rejected).toMatchObject({ monitor: monitored, failed: true });
  });
});
