import { after } from 'next/server';
import { withIoDeadline } from '../io-deadline';
import { errorFields, flushLogEvents, logEvent } from '../observability';
import type { SiteTariffsTimelineResponse } from '../tariff-contract';
import * as client from './client';
import { runUrdbEstimatesForSite } from './estimate-job';

/** Leaves room under the 60-second function limit for the response and log flush. */
export const ESTIMATES_AFTER_MAX_TIME_MS = 40_000;

/**
 * Starts the public-rate estimate right after the response when a change left it pending (a
 * utility, plan, country or rate plan change), so the owner sees it in seconds instead of on the
 * scheduled job's next pass. The job's claim keeps this and the scheduled job from running it
 * twice, and a failed or timed-out run is retried by the scheduled job.
 */
export function startPendingEstimates(
  siteId: string,
  timeline: Pick<SiteTariffsTimelineResponse, 'estimates'>
): void {
  if (timeline.estimates?.status !== 'pending' || !process.env.OPENEI_API_KEY) return;
  after(async () => {
    try {
      const result = await withIoDeadline(ESTIMATES_AFTER_MAX_TIME_MS, () =>
        runUrdbEstimatesForSite(siteId, client, new Date())
      );
      logEvent('info', 'urdb.estimates.after_completed', { siteId, ...result });
    } catch (error) {
      logEvent('warn', 'urdb.estimates.after_failed', { siteId, error: errorFields(error) });
    } finally {
      flushLogEvents();
    }
  });
}
