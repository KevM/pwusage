import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { TariffRepo } from '@/lib/tariff-repo';
import { coverageError } from '@/lib/roi/tou-coverage';
import type { ParsedSeason } from '@/lib/importer/tariff-parser';

export const dynamic = 'force-dynamic';

// listMeteredVersions returns no is_current; the route only needs version + date for ordering.
// (The Tesla-current rate-edit rejection lives in repo.replaceMeteredVersion, not here.)
type Lite = { version: number; effective_from: string | null };

/** Strict-order check: would setting `version` to `date` keep every earlier version's date
 *  below it and every later version's date above it? Compares against the current ordering. */
function ordered(versions: Lite[], version: number, date: string): boolean {
    const others = versions.filter(v => v.version !== version).map(v => v.effective_from).filter((d): d is string => d != null);
    const target = versions.find(v => v.version === version);
    if (!target) return false;
    const earlierMax = versions.filter(v => v.version !== version && v.effective_from != null && v.effective_from < (target.effective_from ?? ''))
        .map(v => v.effective_from as string);
    const laterMin = versions.filter(v => v.version !== version && v.effective_from != null && v.effective_from > (target.effective_from ?? ''))
        .map(v => v.effective_from as string);
    if (others.includes(date)) return false; // distinct dates
    if (earlierMax.some(d => date <= d)) return false;
    if (laterMin.some(d => date >= d)) return false;
    return true;
}

/** GET ?version=N — one metered version's parsed structure, for seeding the editor. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const version = Number(new URL(request.url).searchParams.get('version'));
    if (!Number.isInteger(version)) {
        return NextResponse.json({ error: 'version is required' }, { status: 400 });
    }
    const structure = await new TariffRepo().getMeteredVersionStructure(id, version);
    if (!structure) return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    return NextResponse.json(structure);
}

/** PATCH — date-only edit of one metered version. Clearing snaps the earliest to the install
 *  floor (never null). Rejects a non-monotonic date. */
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
    const repo = new TariffRepo();
    const versions = (await repo.listMeteredVersions(id)) as unknown as Lite[];
    if (!versions.some(v => v.version === version)) {
        return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }
    // No nulls allowed: clearing snaps to the install floor.
    const effectiveFrom = body.effective_from ? String(body.effective_from) : await repo.getSiteInstalledDate(id);
    if (!ordered(versions, version, effectiveFrom)) {
        return NextResponse.json({ error: 'That date would put your plan versions out of order.' }, { status: 400 });
    }
    await repo.setMeteredEffectiveFrom(id, version, effectiveFrom);
    return NextResponse.json({ success: true });
}

/** POST — add a historic plan with ONE date (the switch date onto the next-newer plan). The new
 *  plan anchors at the install floor; the previously-oldest version is bumped to switch_date. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const switchDate = body.switch_date ? String(body.switch_date) : null;
    if (!switchDate) {
        return NextResponse.json({ error: 'A historic plan needs the date you switched onto your next plan.' }, { status: 400 });
    }
    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    const repo = new TariffRepo();
    const installed = await repo.getSiteInstalledDate(id);
    const versions = (await repo.listMeteredVersions(id)) as unknown as Lite[];
    // switch_date must be after the install floor and before the next boundary (the successor of
    // the previously-oldest version, i.e. the second-oldest current date, or "now" if none).
    const dated = versions.map(v => v.effective_from).filter((d): d is string => d != null).sort();
    const nextBoundary = dated[1] ?? new Date().toISOString().slice(0, 10);
    if (switchDate <= installed || switchDate >= nextBoundary) {
        return NextResponse.json({ error: 'The switch date must be after your install date and before your next plan change.' }, { status: 400 });
    }
    await repo.addHistoricMeteredVersion(id, { name: '', seasons }, switchDate);
    return NextResponse.json({ success: true });
}

/** PUT — edit a user-authored historic version's rates + date. The repo rejects the Tesla
 *  current version (rates read-only). Rejects coverage gaps and non-monotonic dates. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    if (!effectiveFrom) {
        return NextResponse.json({ error: 'An effective date is required.' }, { status: 400 });
    }
    const seasons = body.seasons as ParsedSeason[];
    const covErr = coverageError(seasons);
    if (covErr) return NextResponse.json({ error: covErr }, { status: 400 });

    const repo = new TariffRepo();
    const versions = (await repo.listMeteredVersions(id)) as unknown as Lite[];
    if (versions.some(v => v.version === version) && !ordered(versions, version, effectiveFrom)) {
        return NextResponse.json({ error: 'That date would put your plan versions out of order.' }, { status: 400 });
    }
    try {
        await repo.replaceMeteredVersion(id, version, { name: '', seasons }, effectiveFrom);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("current plan's rates") || msg.includes('not found')) {
            return NextResponse.json({ error: msg }, { status: 400 });
        }
        throw e;
    }
    return NextResponse.json({ success: true });
}
