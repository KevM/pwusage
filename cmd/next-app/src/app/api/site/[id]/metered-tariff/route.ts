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

    const repo = new TariffRepo();
    const existingVersions = await repo.listMeteredVersions(id);
    const targetVersion = existingVersions.find(v => v.version === version);
    if (!targetVersion) {
        return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }

    if (effectiveFrom === null && existingVersions.length > 1) {
        const otherVersions = existingVersions.filter(v => v.version !== version);
        const minOtherDate = otherVersions.reduce((min, v) => {
            if (!v.effective_from) return min;
            return !min || v.effective_from < min ? v.effective_from : min;
        }, null as string | null);

        if (targetVersion.effective_from && minOtherDate && targetVersion.effective_from > minOtherDate) {
            return NextResponse.json({ error: 'Only the earliest plan version can have its date cleared.' }, { status: 400 });
        }
    }

    await repo.setMeteredEffectiveFrom(id, version, effectiveFrom);
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

    const repo = new TariffRepo();
    const existingVersions = await repo.listMeteredVersions(id);
    if (existingVersions.some(v => v.effective_from === null)) {
        return NextResponse.json({ error: "Please set your current plan's start date first." }, { status: 400 });
    }

    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    // name is derived from the current metered plan inside the repo; pass seasons as the parsed structure.
    await repo.addHistoricMeteredVersion(id, { name: '', seasons }, effectiveFrom);
    return NextResponse.json({ success: true });
}
