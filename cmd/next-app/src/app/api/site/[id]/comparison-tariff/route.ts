import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { ComparisonTariffRepo } from '@/lib/roi/comparison-tariff-repo';
import { seasonCalendarGaps, windowCoverage } from '@/lib/roi/tou-coverage';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

export const dynamic = 'force-dynamic';

/** First human-readable coverage problem in a structure, or null when fully covered. */
function coverageError(seasons: ParsedSeason[]): string | null {
    if (!Array.isArray(seasons) || seasons.length === 0) return 'At least one season is required.';
    const calGaps = seasonCalendarGaps(seasons);
    if (calGaps.length > 0) {
        const g = calGaps[0];
        return g.count === 0
            ? `No season covers ${g.month}/${g.day} — every day of the year must belong to a season.`
            : `${g.month}/${g.day} is covered by ${g.count} seasons — seasons must not overlap.`;
    }
    for (const s of seasons) {
        const { gaps } = windowCoverage(s);
        if (gaps.length > 0) {
            const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            const c = gaps[0];
            return `Season "${s.name}" leaves ${days[c.weekday]} ${String(c.hour).padStart(2, '0')}:00 unpriced — every hour must be covered by a window.`;
        }
    }
    return null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') ?? '').trim();
    const version = Number(url.searchParams.get('version'));
    if (!name || !Number.isInteger(version)) {
        return NextResponse.json({ error: 'name and version are required' }, { status: 400 });
    }
    const structure = await new ComparisonTariffRepo().getPlanStructure(id, name, version);
    if (!structure) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(structure);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    const intent = body.intent === 'append-version' ? 'append-version' : 'create';
    const seasons = body.seasons as ParsedSeason[];

    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    const repo = new ComparisonTariffRepo();
    if (await repo.nameInUseByMetered(id, name)) {
        return NextResponse.json({ error: `"${name}" is your metered plan's name — choose a different name.` }, { status: 409 });
    }
    if (intent === 'create' && (await repo.comparisonNameInUse(id, name))) {
        return NextResponse.json({ error: `"${name}" already exists — use "+ add version" on that plan instead.` }, { status: 409 });
    }

    await repo.saveComparisonStructure(id, name, effectiveFrom, seasons, intent, undefined);
    return NextResponse.json({ success: true });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    const repo = new ComparisonTariffRepo();

    if (body.intent === 'rename') {
        const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
        if (!newName) return NextResponse.json({ error: 'newName is required' }, { status: 400 });
        if (await repo.nameInUseByMetered(id, newName) || await repo.comparisonNameInUse(id, newName)) {
            return NextResponse.json({ error: `"${newName}" is already in use — choose a different name.` }, { status: 409 });
        }
        await repo.renameComparisonPlan(id, name, newName);
        return NextResponse.json({ success: true });
    }

    const version = Number(body.version);
    if (!Number.isInteger(version)) {
        return NextResponse.json({ error: 'version is required' }, { status: 400 });
    }
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    await repo.saveComparisonStructure(id, name, effectiveFrom, seasons, 'replace', version);
    return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

    const repo = new ComparisonTariffRepo();
    if (body.version === undefined || body.version === null) {
        await repo.deleteComparisonPlan(id, name);
    } else {
        const version = Number(body.version);
        if (!Number.isInteger(version)) {
            return NextResponse.json({ error: 'version must be an integer' }, { status: 400 });
        }
        await repo.deleteComparisonVersion(id, name, version);
    }
    return NextResponse.json({ success: true });
}
