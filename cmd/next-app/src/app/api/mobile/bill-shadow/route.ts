import { NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { compareShadowDays, summarizeShadowDays, type ShadowDay, type ShadowDayDiff } from '@/lib/bill-shadow-days';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { logEvent } from '@/lib/observability';
import { withRequestContext } from '@/lib/request-context';
import { SiteRepo } from '@/lib/site-repo';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;
/** A billing cycle has at most 31 days; leave room for a cycle that straddles a DST change. */
const MAX_LOCAL_DAYS = 40;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRIVATE_RESPONSE = { 'Cache-Control': 'private, no-store' };

interface BillShadowPeriod {
    tariffName: string;
    periodName: string;
    cost: number;
}

interface BillShadowSummary {
    estimatedCost: number | null;
    periods: BillShadowPeriod[];
}

interface BillShadowReport {
    siteId: string;
    appBuild: string;
    cycleStart: string;
    server: BillShadowSummary;
    local: BillShadowSummary;
    reattributionRunning: boolean;
    /** The phone's net grid energy and last slot per site-local day of the cycle, when it sent them. */
    localDays?: ShadowDay[];
}

function jsonError(error: string, status: number): NextResponse {
    return NextResponse.json({ error }, { status, headers: PRIVATE_RESPONSE });
}

function parsePeriod(raw: unknown): BillShadowPeriod | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (
        typeof obj.tariffName !== 'string'
        || typeof obj.periodName !== 'string'
        || typeof obj.cost !== 'number'
        || !Number.isFinite(obj.cost)
    ) {
        return null;
    }
    return {
        tariffName: obj.tariffName,
        periodName: obj.periodName,
        cost: obj.cost,
    };
}

function parseSummary(raw: unknown): BillShadowSummary | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    let estimatedCost: number | null;
    if (obj.estimatedCost === null) {
        estimatedCost = null;
    } else if (typeof obj.estimatedCost === 'number' && Number.isFinite(obj.estimatedCost)) {
        estimatedCost = obj.estimatedCost;
    } else {
        return null;
    }
    if (!Array.isArray(obj.periods)) return null;
    const periods: BillShadowPeriod[] = [];
    for (const item of obj.periods) {
        const parsed = parsePeriod(item);
        if (!parsed) return null;
        periods.push(parsed);
    }
    return { estimatedCost, periods };
}

/** `undefined` when absent, `null` when malformed. */
function parseLocalDays(raw: unknown): ShadowDay[] | null | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length > MAX_LOCAL_DAYS) return null;
    const days: ShadowDay[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const { day, gridWh, last } = item as Record<string, unknown>;
        if (typeof day !== 'string' || !DAY_PATTERN.test(day)) return null;
        if (typeof gridWh !== 'number' || !Number.isFinite(gridWh)) return null;
        // The phone omits `last` for a day without data.
        if (last !== undefined && last !== null && (typeof last !== 'string' || !Number.isFinite(Date.parse(last)))) return null;
        days.push({ day, gridWh, last: typeof last === 'string' ? last : null });
    }
    return days;
}

function parseReport(raw: unknown): BillShadowReport | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if ('location' in obj || 'flows' in obj) return null;
    if (
        typeof obj.siteId !== 'string'
        || obj.siteId.length === 0
        || typeof obj.appBuild !== 'string'
        || typeof obj.cycleStart !== 'string'
        || obj.cycleStart.length === 0
        || typeof obj.reattributionRunning !== 'boolean'
    ) {
        return null;
    }
    const server = parseSummary(obj.server);
    const local = parseSummary(obj.local);
    if (!server || !local) return null;
    const localDays = parseLocalDays(obj.localDays);
    if (localDays === null) return null;
    return {
        siteId: obj.siteId,
        appBuild: obj.appBuild,
        cycleStart: obj.cycleStart,
        server,
        local,
        reattributionRunning: obj.reattributionRunning,
        ...(localDays ? { localDays } : {}),
    };
}

/** The server's per-day totals for the cycle, read now, compared with the phone's. Never fails the report. */
async function dayDiffFields(report: BillShadowReport & { localDays: ShadowDay[] }): Promise<{
    dayDiffs: ShadowDayDiff[] | null;
    dayDiffsError?: string;
}> {
    try {
        const cycleStart = new Date(report.cycleStart);
        if (!Number.isFinite(+cycleStart)) throw new Error('Invalid cycleStart');
        const site = await new SiteRepo().getSite(report.siteId);
        if (!site) throw new Error('Site not found');
        const rows = await createEnergyRepo(site.timezone).getRawEnergyData(report.siteId, cycleStart, new Date());
        return { dayDiffs: compareShadowDays(summarizeShadowDays(rows, site.timezone), report.localDays) };
    } catch (error) {
        return { dayDiffs: null, dayDiffsError: error instanceof Error ? error.message : String(error) };
    }
}

interface PeriodDiff {
    tariffName: string;
    periodName: string;
    serverCost: number | null;
    localCost: number | null;
    diff: number;
}

function buildPeriodDiffs(server: BillShadowPeriod[], local: BillShadowPeriod[]): PeriodDiff[] {
    const map = new Map<string, { tariffName: string; periodName: string; serverCost: number | null; localCost: number | null }>();
    const upsert = (p: BillShadowPeriod, side: 'server' | 'local') => {
        const key = `${p.tariffName}\0${p.periodName}`;
        const existing = map.get(key) ?? {
            tariffName: p.tariffName,
            periodName: p.periodName,
            serverCost: null,
            localCost: null,
        };
        if (side === 'server') {
            existing.serverCost = (existing.serverCost ?? 0) + p.cost;
        } else {
            existing.localCost = (existing.localCost ?? 0) + p.cost;
        }
        map.set(key, existing);
    };
    for (const p of server) upsert(p, 'server');
    for (const p of local) upsert(p, 'local');
    return Array.from(map.values()).map((entry) => ({
        ...entry,
        diff: (entry.localCost ?? 0) - (entry.serverCost ?? 0),
    }));
}

export async function POST(request: Request): Promise<NextResponse> {
    return withRequestContext(async () => {
        const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
            return jsonError('Content-Type must be application/json', 415);
        }

        const rawText = await request.text();
        if (Buffer.byteLength(rawText, 'utf8') > MAX_BODY_BYTES) {
            return jsonError('Request body too large', 400);
        }

        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(rawText);
        } catch {
            return jsonError('Invalid JSON body', 400);
        }

        const report = parseReport(parsedJson);
        if (!report) {
            return jsonError('Invalid bill shadow report', 400);
        }

        if (!(await verifySiteAccess(report.siteId))) {
            return jsonError('Unauthorized', 401);
        }

        const estimatedCostDiff = report.server.estimatedCost !== null && report.local.estimatedCost !== null
            ? report.local.estimatedCost - report.server.estimatedCost
            : null;
        const periodDiffs = buildPeriodDiffs(report.server.periods, report.local.periods);
        const localDays = report.localDays;
        const days = localDays ? await dayDiffFields({ ...report, localDays }) : {};

        logEvent('warn', 'mobile.bill-shadow.mismatch', {
            siteId: report.siteId,
            appBuild: report.appBuild,
            cycleStart: report.cycleStart,
            reattributionRunning: report.reattributionRunning,
            serverEstimatedCost: report.server.estimatedCost,
            localEstimatedCost: report.local.estimatedCost,
            estimatedCostDiff,
            periodDiffs,
            ...days,
        });
        return new NextResponse(null, { status: 204, headers: PRIVATE_RESPONSE });
    });
}
