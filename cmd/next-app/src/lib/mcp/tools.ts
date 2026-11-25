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
            utility: site.utility ?? null,
            timezone: site.timezone,
            billingStartDay: site.billing_start_day ?? 1,
            setupStatus: {
                hasTariff: Array.isArray(site.tariffs) && site.tariffs.length > 0,
                billingDayConfirmed: site.billing_start_day_confirmed_at !== null && site.billing_start_day_confirmed_at !== undefined,
            },
        })),
    });
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
        gridPowerW: live.liveStatus.grid_power ?? null,
        batteryPowerW: live.liveStatus.battery_power ?? null,
        batterySocPercent: live.liveStatus.percentage_charged ?? null,
        gridStatus: live.liveStatus.grid_status ?? null,
        backupCapable: live.liveStatus.backup_capable ?? null,
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

    const billing = await readCurrentBilling(target.siteId, {
        includeOutlook: true,
        includeLoadTimingTimeline: true,
        refreshStale: true,
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

    const res = await pool.query<{
        day: string;
        load_kwh: string | number;
        solar_kwh: string | number;
        grid_import_kwh: string | number;
        grid_export_kwh: string | number;
        battery_charge_kwh: string | number;
        battery_discharge_kwh: string | number;
        sample_count: number;
    }>(
        `SELECT (a.day_start AT TIME ZONE $4)::date::text AS day,
                ROUND((COALESCE(SUM(s.load_power), 0) / 12000.0)::numeric, 3) AS load_kwh,
                ROUND((COALESCE(SUM(s.solar_power), 0) / 12000.0)::numeric, 3) AS solar_kwh,
                ROUND((COALESCE(SUM(s.sample_import_wh), 0) / 1000.0)::numeric, 3) AS grid_import_kwh,
                ROUND((COALESCE(SUM(s.sample_export_wh), 0) / 1000.0)::numeric, 3) AS grid_export_kwh,
                ROUND((COALESCE(SUM(s.sample_charge_wh), 0) / 1000.0)::numeric, 3) AS battery_charge_kwh,
                ROUND((COALESCE(SUM(s.sample_discharge_wh), 0) / 1000.0)::numeric, 3) AS battery_discharge_kwh,
                COALESCE(SUM(s.sample_count), 0)::int AS sample_count
         FROM "EnergyDayArchive" a
         INNER JOIN "EnergyDaySummary" s
           ON s.site_id = a.site_id AND s.day_start = a.day_start AND s.revision = a.revision
         WHERE a.site_id = $1
           AND (a.day_start AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
         GROUP BY (a.day_start AT TIME ZONE $4)::date
         ORDER BY day ASC`,
        [target.siteId, fromDate, toDate, timezone],
    );

    const days = res.rows.map(row => ({
        date: row.day,
        loadKwh: Number(row.load_kwh),
        solarKwh: Number(row.solar_kwh),
        gridImportKwh: Number(row.grid_import_kwh),
        gridExportKwh: Number(row.grid_export_kwh),
        batteryChargeKwh: Number(row.battery_charge_kwh),
        batteryDischargeKwh: Number(row.battery_discharge_kwh),
        sampleCount: row.sample_count,
    }));

    return textResult({
        siteId: target.siteId,
        fromDate,
        toDate,
        syncInProgress: days.length === 0,
        days,
    });
}
