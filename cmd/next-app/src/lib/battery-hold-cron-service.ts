import { BatteryHoldRepo } from './battery-hold-repo';
import { monitorBatteryHolds } from './battery-hold-monitor-service';
import {
  deliverBatteryHoldActivities, DELIVERY_SEND_BUDGET_MS, type DeliverySummary,
} from './battery-hold-activity-delivery-service';
import { withIoDeadline } from './io-deadline';
import type { BatteryHold } from './db';

// One Battery Saver run inside the route's 60 s Hobby cap: check every active
// hold, then send the Live Activity updates that check produced. The monitor
// runs first so a slow Apple endpoint can never delay a restore.
export const BATTERY_HOLD_CRON_BUDGET_MS = 55_000;
// Delivery's bookkeeping writes and APNs session close after its send deadline.
const DELIVERY_TAIL_MS = 5_000;
// Below this, delivery could not finish one APNs request after reconcile and claim.
const MIN_SEND_BUDGET_MS = 5_000;
const HOLDS_LOAD_BUDGET_MS = 2_000;

type MonitorSummary = Awaited<ReturnType<typeof monitorBatteryHolds>>;

export interface BatteryHoldCronDeps {
  loadHolds?: () => Promise<BatteryHold[]>;
  monitor?: (holds: BatteryHold[]) => Promise<MonitorSummary>;
  deliver?: (options: { sendBudgetMs: number }) => Promise<DeliverySummary>;
  now?: () => number;
}

export interface BatteryHoldCronResult {
  monitor: MonitorSummary | null;
  monitorError: unknown;
  delivery: DeliverySummary | null;
  deliveryError: unknown;
  /** The monitor left too little time; pending updates go out on the next run. */
  deliverySkipped: boolean;
  failed: boolean;
}

export async function runBatteryHoldCron(deps: BatteryHoldCronDeps = {}): Promise<BatteryHoldCronResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result: BatteryHoldCronResult = {
    monitor: null, monitorError: null, delivery: null, deliveryError: null, deliverySkipped: false, failed: false,
  };
  try {
    const holds = await (deps.loadHolds ?? (() => withIoDeadline(HOLDS_LOAD_BUDGET_MS, () => new BatteryHoldRepo().getAllActiveHolds())))();
    result.monitor = await (deps.monitor ?? monitorBatteryHolds)(holds);
  } catch (e) {
    result.monitorError = e;
  }
  const sendBudgetMs = Math.min(DELIVERY_SEND_BUDGET_MS, BATTERY_HOLD_CRON_BUDGET_MS - (now() - started) - DELIVERY_TAIL_MS);
  if (sendBudgetMs < MIN_SEND_BUDGET_MS) {
    result.deliverySkipped = true;
  } else {
    try {
      result.delivery = await (deps.deliver ?? (options => deliverBatteryHoldActivities(options)))({ sendBudgetMs });
    } catch (e) {
      result.deliveryError = e;
    }
  }
  result.failed = result.monitorError !== null || result.deliveryError !== null || !!result.delivery?.credentialFailure;
  return result;
}
