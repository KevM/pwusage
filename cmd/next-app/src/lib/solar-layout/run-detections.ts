// Scheduled solar layout detection (/api/cron/detect-solar-layouts): a few due
// beta sites per run, each from its last 365 days of day records, inside the
// Hobby 60 s limit. A site that throws or runs past its deadline keeps its
// previous result and is not retried for 24 hours; the next site still runs.
import { logEvent } from '@/lib/observability';
import type { DueSite, SolarLayoutRepo } from '@/lib/solar-layout-repo';
import { detectSolarLayout, SOLAR_LAYOUT_DETECTOR_VERSION } from './detect';

export const DETECTION_SITES_PER_RUN = 5;
export const DETECTION_HISTORY_DAYS = 365;
/** Detection is synchronous CPU work, so it carries its own deadline inside the 50 s I/O deadline. */
export const DETECTION_DEADLINE_MS = 48_000;

export type DetectionRepo = Pick<SolarLayoutRepo, 'listDue' | 'saveResult' | 'recordFailure'>;
export type SampleLoader = (siteId: string, timeZone: string, start: Date, end: Date) => Promise<{ timestamp: Date; solarWh: number }[]>;

export async function runDueDetections(opts: {
    now: Date; budgetMs: number; repo: DetectionRepo; loadSamples: SampleLoader;
    clock?: () => number; detect?: typeof detectSolarLayout; deadlineMs?: number;
}): Promise<{ sites: { siteId: string; status: string; ms: number }[]; stopped: boolean }> {
    const clock = opts.clock ?? Date.now;
    const detect = opts.detect ?? detectSolarLayout;
    const startedAt = clock();
    const deadline = startedAt + (opts.deadlineMs ?? DETECTION_DEADLINE_MS);
    const sites: { siteId: string; status: string; ms: number }[] = [];
    if (opts.budgetMs <= 0) return { sites, stopped: true };
    const due: DueSite[] = await opts.repo.listDue(DETECTION_SITES_PER_RUN, opts.now);
    let stopped = false;
    for (const site of due) {
        if (clock() - startedAt >= opts.budgetMs) {
            stopped = true;
            break;
        }
        const siteStarted = clock();
        try {
            const end = opts.now;
            const start = new Date(end.getTime() - DETECTION_HISTORY_DAYS * 86_400_000);
            const samples = await opts.loadSamples(site.siteId, site.timezone, start, end);
            const result = detect({ samples, latitude: site.latitude, longitude: site.longitude, timeZone: site.timezone, deadline });
            await opts.repo.saveResult(site.siteId, result, SOLAR_LAYOUT_DETECTOR_VERSION);
            sites.push({ siteId: site.siteId, status: result.status, ms: clock() - siteStarted });
        } catch (error) {
            logEvent('warn', 'cron.detect-solar-layouts.site-failed', { siteId: site.siteId, error });
            try {
                await opts.repo.recordFailure(site.siteId);
            } catch (recordError) {
                logEvent('error', 'cron.detect-solar-layouts.record-failure-failed', { siteId: site.siteId, error: recordError });
            }
            sites.push({ siteId: site.siteId, status: 'failed', ms: clock() - siteStarted });
        }
    }
    return { sites, stopped };
}
