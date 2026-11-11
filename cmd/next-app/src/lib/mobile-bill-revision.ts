import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { pool, type SiteWithTariffs } from './db';
import { readMobileHistoryRevision } from './mobile-history-revision';
import { getRequestContext } from './request-context';
import type { SiteRepo } from './site-repo';
import type { Schedule } from './schedule';
import type { ReattributionStatusDTO } from './tariff-contract';
import { getSiteReattributionStatus } from './tariff-reattribution';

const HOUR_NS = 3_600_000_000_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface MobileBillConfiguration {
    name: string;
    timezone: string;
    billing_start_day: number | null;
    currency: string | null;
    tariff_ids: number[];
}

/** Read the current configuration independently of the per-instance site cache. */
export async function readMobileBillConfiguration(siteId: string): Promise<MobileBillConfiguration | undefined> {
    const result = await pool.query<MobileBillConfiguration>(`
        SELECT name, timezone, billing_start_day, json -> 'tariff_content_v2' ->> 'currency' AS currency,
            ARRAY(SELECT id FROM "Tariff" WHERE site_id = s.id AND is_current ORDER BY id) AS tariff_ids
        FROM "Site" s WHERE id = $1
    `, [siteId]);
    return result.rows[0];
}

export function matchesMobileBillConfiguration(site: SiteWithTariffs, config: MobileBillConfiguration): boolean {
    const tariffIDs = site.tariffs.map(tariff => tariff.id).sort((a, b) => a - b);
    return config.name === site.name && config.timezone === site.timezone
        && (config.billing_start_day || 1) === (site.billing_start_day || 1)
        && tariffIDs.length === config.tariff_ids.length && tariffIDs.every((id, index) => id === config.tariff_ids[index]);
}

/**
 * Load a site that matches current configuration, which another instance may
 * have edited. `config` is set only when it describes the returned site.
 */
export async function readCurrentMobileSite(
    siteRepo: Pick<SiteRepo, 'getSite' | 'invalidateCache'>, siteId: string
): Promise<{ site?: SiteWithTariffs; config: MobileBillConfiguration | null }> {
    const site = await siteRepo.getSite(siteId);
    const config = site && await readMobileBillConfiguration(siteId);
    if (!site || !config) return { config: null };
    if (matchesMobileBillConfiguration(site, config)) return { site, config };
    getRequestContext().siteCache.delete(siteId);
    siteRepo.invalidateCache(siteId);
    const reloaded = await siteRepo.getSite(siteId);
    return { site: reloaded, config: reloaded && matchesMobileBillConfiguration(reloaded, config) ? config : null };
}

function timingWindow(now: Date, schedule: Schedule): string | number {
    const time = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(schedule.siteTimeZone);
    const transition = time.getTimeZoneTransition('next');
    const fractionalOffsetChange = transition && transition.epochMilliseconds < now.getTime() + WEEK_MS
        && (transition.offsetNanoseconds - time.offsetNanoseconds) % HOUR_NS !== 0;
    // The relative timing helper samples the next week hourly. Sub-hour
    // boundaries can affect what it sees as the minute within the hour changes.
    if (fractionalOffsetChange || schedule.boundaryMinutes().some(minute => minute % 60 !== 0)) {
        return Math.floor(now.getTime() / 60_000);
    }
    return `${time.toPlainDate()}T${time.hour}${time.offset}`;
}

export async function readMobileBillRevision(
    site: SiteWithTariffs,
    config: MobileBillConfiguration,
    schedule: Schedule,
    cycleStart: Date,
    cycleEnd: Date,
    now: Date,
    includeOutlook: boolean,
    reattribution?: ReattributionStatusDTO | null,
): Promise<string | null> {
    const history = await readMobileHistoryRevision(site.id, cycleStart, cycleEnd);
    if (!history.latest || history.latest >= now || history.hasFutureSamples) return null;
    const active = schedule.getTariffPeriod(now);
    const activeReattribution = reattribution === undefined
        ? await getSiteReattributionStatus(site.id)
        : reattribution;
    const reattributionKey = activeReattribution && activeReattribution.status !== 'idle'
        ? [activeReattribution.status, activeReattribution.processedDays, activeReattribution.updatedDays]
        : null;
    return createHash('sha256').update(JSON.stringify([
        1, site.id, config, cycleStart, cycleEnd, history.revision, includeOutlook,
        timingWindow(now, schedule), active?.schedule.id, reattributionKey,
    ])).digest('hex');
}
