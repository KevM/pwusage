import { readCurrentBilling } from '@/lib/current-billing-service';
import { getSiteTodayDateStr, getValidTimezone } from '@/lib/date-utils';
import { pool } from '@/lib/db';
import type { OAuthAccessContext, OAuthScope } from '@/lib/oauth/types';
import { SiteRepo } from '@/lib/site-repo';
import { refreshLiveStatus } from '@/lib/today-refresh';
import { getAppBaseUrl } from '@/lib/url-utils';

export interface McpToolResult {
    [key: string]: unknown;
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

function textResult(data: unknown, isError = false): McpToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        ...(isError ? { isError: true } : {}),
    };
}

function errorResult(message: string): McpToolResult {
    return {
        content: [{ type: 'text', text: message }],
        isError: true,
    };
}

function hasScope(ctx: OAuthAccessContext, scope: OAuthScope): boolean {
    return ctx.scopes.includes(scope);
}

export function resolveTargetSiteId(
    ctx: OAuthAccessContext,
    requestedSiteId?: string,
): { ok: true; siteId: string } | { ok: false; error: string } {
    if (requestedSiteId) {
        if (ctx.authorizedSiteIds.includes(requestedSiteId)) {
            return { ok: true, siteId: requestedSiteId };
        }
        return {
            ok: false,
            error: `site_not_authorized: ${requestedSiteId} is not authorized for this connection.`,
        };
    }
    if (ctx.authorizedSiteIds.length === 1) {
        return { ok: true, siteId: ctx.authorizedSiteIds[0] };
    }
    if (ctx.authorizedSiteIds.length === 0) {
        return { ok: false, error: 'No authorized homes available for this connection.' };
    }
    return {
        ok: false,
        error: 'Multiple homes are authorized. Call list_homes first and pass site_id.',
    };
}

function buildSetupNotice(
    site: { id: string; tariffs?: unknown[]; billing_start_day_confirmed_at?: Date | null },
    origin: string,
) {
    const hasTariff = Array.isArray(site.tariffs) && site.tariffs.length > 0;
    const billingDayConfirmed = site.billing_start_day_confirmed_at !== null && site.billing_start_day_confirmed_at !== undefined;
    if (hasTariff && billingDayConfirmed) return undefined;
    return {
        missingTariff: !hasTariff,
        missingBillingStartDay: !billingDayConfirmed,
        message: 'Complete your rate plan and billing start day in PWUsage Settings for accurate bill and Smart Shift calculations.',
        settingsUrl: `${origin}/site/${encodeURIComponent(site.id)}/settings`,
    };
}

export async function handleListHomes(ctx: OAuthAccessContext): Promise<McpToolResult> {
    if (!hasScope(ctx, 'billing:read') && !hasScope(ctx, 'usage:read')) {
        return errorResult('insufficient_scope: requires billing:read or usage:read');
    }
    const siteRepo = new SiteRepo();
    const loaded = await Promise.all(ctx.authorizedSiteIds.map(id => siteRepo.getSite(id)));
    const sites = loaded.filter((s): s is NonNullable<typeof s> => Boolean(s));
    return textResult({
        homes: sites.map(site => ({
            siteId: site.id,
            name: site.name,
            utility: site.utility?.trim() || null,
            timezone: site.timezone,
            billingStartDay: site.billing_start_day ?? 1,
            setupStatus: {
                hasTariff: Array.isArray(site.tariffs) && site.tariffs.length > 0,
                billingDayConfirmed: site.billing_start_day_confirmed_at !== null && site.billing_start_day_confirmed_at !== undefined,
            },
        })),
    });
}

/** One signed Tesla power reading → two non-negative named watts, e.g. gridImportW / gridExportW. */
function splitFlow<P extends string, A extends string, B extends string>(
    prefix: P, positive: A, negative: B, watts: number | null | undefined,
): Record<`${P}${A}W` | `${P}${B}W`, number | null> {
    const w = typeof watts === 'number' && Number.isFinite(watts) ? watts : null;
    return {
        [`${prefix}${positive}W`]: w === null ? null : Math.max(w, 0),
        [`${prefix}${negative}W`]: w === null ? null : Math.max(-w, 0),
    } as Record<`${P}${A}W` | `${P}${B}W`, number | null>;
}

export async function handleGetLiveStatus(
    ctx: OAuthAccessContext,
    args: { site_id?: string },
): Promise<McpToolResult> {
    if (!hasScope(ctx, 'usage:read')) {
        return errorResult('insufficient_scope: requires usage:read');
    }
    const target = resolveTargetSiteId(ctx, args.site_id);
    if (!target.ok) return errorResult(target.error);

    const live = await refreshLiveStatus(target.siteId, { liveOnly: true });
    if (live.status === 'site-not-found') {
        return errorResult('site_not_found');
    }
    if (!live.liveStatus) {
        return errorResult(`Live Powerwall status is temporarily unavailable (${live.status}).`);
    }

    return textResult({
        siteId: target.siteId,
        statusSource: live.status,
        fetchedAt: live.fetchedAt ? new Date(live.fetchedAt).toISOString() : null,
        solarPowerW: live.liveStatus.solar_power ?? null,
        loadPowerW: live.liveStatus.load_power ?? null,
        // Tesla signs: grid_power > 0 imports, battery_power > 0 discharges. Split
        // into named directions so no caller has to know (stored history flips the battery sign).
        ...splitFlow('grid', 'Import', 'Export', live.liveStatus.grid_power),
        ...splitFlow('battery', 'Discharging', 'Charging', live.liveStatus.battery_power),
        batterySocPercent: live.liveStatus.percentage_charged ?? null,
        gridStatus: live.liveStatus.grid_status ?? null,
        stormModeActive: live.liveStatus.storm_mode_active ?? null,
    });
}

export async function handleGetCurrentBill(
    ctx: OAuthAccessContext,
    args: { site_id?: string },
): Promise<McpToolResult> {
    if (!hasScope(ctx, 'billing:read')) {
        return errorResult('insufficient_scope: requires billing:read');
    }
    const target = resolveTargetSiteId(ctx, args.site_id);
    if (!target.ok) return errorResult(target.error);

    const site = await new SiteRepo().getSite(target.siteId);
    if (!site) return errorResult('site_not_found');

    // Same read as the billing integration: no outlook, no Smart Shift timeline
    // (get_smart_shift_outlook carries those).
    const billing = await readCurrentBilling(target.siteId, {
        refreshStale: true,
        includeLoadTimingTimeline: false,
    });
    if (billing.status !== 'current') {
        return errorResult('Unable to load current bill.');
    }

    const setupNotice = buildSetupNotice(site, getAppBaseUrl());
    return textResult({
        siteId: target.siteId,
        siteName: billing.summary.site.name,
        timezone: billing.summary.site.timezone,
        currentBill: billing.summary.currentBill,
        loadTiming: billing.summary.loadTiming ?? null,
        energyDataThrough: billing.summary.sources.energyDataThrough,
        ...(setupNotice ? { setupNotice } : {}),
    });
}

export async function handleGetSmartShiftOutlook(
    ctx: OAuthAccessContext,
    args: { site_id?: string },
): Promise<McpToolResult> {
    if (!hasScope(ctx, 'billing:read')) {
        return errorResult('insufficient_scope: requires billing:read');
    }
    const target = resolveTargetSiteId(ctx, args.site_id);
    if (!target.ok) return errorResult(target.error);

    const site = await new SiteRepo().getSite(target.siteId);
    if (!site) return errorResult('site_not_found');

    const billing = await readCurrentBilling(target.siteId, {
        includeOutlook: true,
        includeLoadTimingTimeline: true,
        refreshStale: true,
    });
    if (billing.status !== 'current') {
        return errorResult('Unable to load Smart Shift outlook.');
    }

    const setupNotice = buildSetupNotice(site, getAppBaseUrl());
    return textResult({
        siteId: target.siteId,
        siteName: billing.summary.site.name,
        timezone: billing.summary.site.timezone,
        loadTiming: billing.summary.loadTiming,
        upcomingRateTimeline: billing.summary.outlook?.tariffTimeline ?? [],
        energyDataThrough: billing.summary.sources.energyDataThrough,
        ...(setupNotice ? { setupNotice } : {}),
    });
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatUtcDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Wh (pg may return a numeric as a string) → kWh rounded to 3 decimals. */
function whToKwh(wh: string | number): number {
    return Math.round(Number(wh)) / 1000;
}

interface DailyUsageRow {
    day: string;
    status: 'open' | 'complete' | 'gapped' | 'empty' | null;
    sample_count: number;
    expected_slots: number;
    load_wh: string | number | null;
    solar_wh: string | number | null;
    grid_import_wh: string | number | null;
    grid_export_wh: string | number | null;
    battery_charge_wh: string | number | null;
    battery_discharge_wh: string | number | null;
}

/**
 * complete: every 5-minute sample. partial: still filling in (today, or a recent
 * day awaiting gap healing). gapped: ended short and past healing. no_data: Tesla
 * returned no samples. missing: never imported.
 */
type DailyUsageStatus = 'complete' | 'partial' | 'gapped' | 'no_data' | 'missing';

interface DailyUsageDay {
    date: string;
    status: DailyUsageStatus;
    sampleCount: number;
    expectedSamples: number | null;
    loadKwh: number | null;
    solarKwh: number | null;
    gridImportKwh: number | null;
    gridExportKwh: number | null;
    batteryChargeKwh: number | null;
    batteryDischargeKwh: number | null;
}

function dailyUsageStatus(row: DailyUsageRow): DailyUsageStatus {
    switch (row.status) {
        case 'complete': return 'complete';
        case 'gapped': return 'gapped';
        case 'empty': return 'no_data';
        case 'open': return 'partial';
        // v1 records carry no status: judge by their sample count.
        default: return row.sample_count >= row.expected_slots ? 'complete' : 'partial';
    }
}

function toDailyUsageDay(date: string, row: DailyUsageRow | undefined): DailyUsageDay {
    const status = row ? dailyUsageStatus(row) : 'missing';
    const hasTotals = row !== undefined && row.sample_count > 0 && row.load_wh !== null;
    const kwh = (wh: string | number | null | undefined) => (hasTotals && wh !== null && wh !== undefined ? whToKwh(wh) : null);
    return {
        date,
        status,
        sampleCount: row?.sample_count ?? 0,
        expectedSamples: row?.expected_slots ?? null,
        loadKwh: kwh(row?.load_wh),
        solarKwh: kwh(row?.solar_wh),
        gridImportKwh: kwh(row?.grid_import_wh),
        gridExportKwh: kwh(row?.grid_export_wh),
        batteryChargeKwh: kwh(row?.battery_charge_wh),
        batteryDischargeKwh: kwh(row?.battery_discharge_wh),
    };
}

export async function handleGetDailyUsage(
    ctx: OAuthAccessContext,
    args: { site_id?: string; from_date?: string; to_date?: string },
): Promise<McpToolResult> {
    if (!hasScope(ctx, 'usage:read')) {
        return errorResult('insufficient_scope: requires usage:read');
    }
    const target = resolveTargetSiteId(ctx, args.site_id);
    if (!target.ok) return errorResult(target.error);

    const site = await new SiteRepo().getSite(target.siteId);
    if (!site) return errorResult('site_not_found');
    const timezone = getValidTimezone(site.timezone);

    const toDate = args.to_date ?? getSiteTodayDateStr(timezone);
    if (!ISO_DATE_RE.test(toDate)) {
        return errorResult('from_date and to_date must be YYYY-MM-DD.');
    }
    const toMs = Date.parse(`${toDate}T00:00:00Z`);
    const fromDate = args.from_date ?? formatUtcDate(new Date(toMs - 6 * 86_400_000));

    if (!ISO_DATE_RE.test(fromDate)) {
        return errorResult('from_date and to_date must be YYYY-MM-DD.');
    }

    const fromMs = Date.parse(`${fromDate}T00:00:00Z`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
        return errorResult('from_date must be on or before to_date.');
    }
    const daySpan = Math.round((toMs - fromMs) / 86_400_000) + 1;
    if (daySpan > 31) {
        return errorResult('Date range is capped at 31 days per request.');
    }

    // One row per day record. Every EnergyDaySummary energy column is Wh summed
    // over that day's samples (rollupDay), so all six convert to kWh the same way.
    // LEFT JOIN: an `empty` record has no summary rows but is still a known day.
    const res = await pool.query<DailyUsageRow>(
        `SELECT (a.day_start AT TIME ZONE $4)::date::text AS day,
                a.status,
                a.sample_count,
                a.expected_slots,
                SUM(s.load_power) AS load_wh,
                SUM(s.solar_power) AS solar_wh,
                SUM(s.sample_import_wh) AS grid_import_wh,
                SUM(s.sample_export_wh) AS grid_export_wh,
                SUM(s.sample_charge_wh) AS battery_charge_wh,
                SUM(s.sample_discharge_wh) AS battery_discharge_wh
         FROM "EnergyDayArchive" a
         LEFT JOIN "EnergyDaySummary" s
           ON s.site_id = a.site_id AND s.day_start = a.day_start AND s.revision = a.revision
         WHERE a.site_id = $1
           AND (a.day_start AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
         GROUP BY a.day_start, a.status, a.sample_count, a.expected_slots
         ORDER BY day ASC`,
        [target.siteId, fromDate, toDate, timezone],
    );

    // List every requested date up to the site's today, so a day with no record
    // shows as `missing` instead of silently dropping out of the range.
    const byDate = new Map(res.rows.map(row => [row.day, row]));
    const lastDate = [toDate, getSiteTodayDateStr(timezone)].sort()[0];
    const days: DailyUsageDay[] = [];
    for (let ms = fromMs; formatUtcDate(new Date(ms)) <= lastDate; ms += 86_400_000) {
        const date = formatUtcDate(new Date(ms));
        days.push(toDailyUsageDay(date, byDate.get(date)));
    }

    return textResult({
        siteId: target.siteId,
        fromDate,
        toDate,
        syncInProgress: res.rows.length === 0,
        days,
    });
}
