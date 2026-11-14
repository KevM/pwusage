import { NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;
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
    return {
        siteId: obj.siteId,
        appBuild: obj.appBuild,
        cycleStart: obj.cycleStart,
        server,
        local,
        reattributionRunning: obj.reattributionRunning,
    };
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

        console.warn('[bill-shadow]', JSON.stringify(report));
        return new NextResponse(null, { status: 204, headers: PRIVATE_RESPONSE });
    });
}
