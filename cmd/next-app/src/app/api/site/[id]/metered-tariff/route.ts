import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { TariffRepo } from '@/lib/tariff-repo';
import { coverageError } from '@/lib/roi/tou-coverage';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

export const dynamic = 'force-dynamic';

/** Correct/set the effective date of one metered version. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const version = Number(body.version);
    if (!Number.isInteger(version)) {
        return NextResponse.json({ error: 'version is required' }, { status: 400 });
    }
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    await new TariffRepo().setMeteredEffectiveFrom(id, version, effectiveFrom);
    return NextResponse.json({ success: true });
}

/** Add a user-authored historic metered version (a past plan the importer never saw). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    if (!effectiveFrom) {
        return NextResponse.json({ error: 'A historic version needs an effective date.' }, { status: 400 });
    }
    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    // name is derived from the current metered plan inside the repo; pass seasons as the parsed structure.
    await new TariffRepo().addHistoricMeteredVersion(id, { name: '', seasons }, effectiveFrom);
    return NextResponse.json({ success: true });
}
