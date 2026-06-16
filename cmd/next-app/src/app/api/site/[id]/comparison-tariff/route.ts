import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { ComparisonTariffRepo } from '@/lib/roi/comparison-tariff-repo';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const buyRate = Number(body.buy_rate);
    const sellRate = Number(body.sell_rate);
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;
    const intent = body.intent === 'append-version' ? 'append-version' : 'create';

    if (!name || !Number.isFinite(buyRate) || !Number.isFinite(sellRate)) {
        return NextResponse.json({ error: 'name, buy_rate and sell_rate are required' }, { status: 400 });
    }

    const repo = new ComparisonTariffRepo();
    if (await repo.nameInUseByMetered(id, name)) {
        return NextResponse.json({ error: `"${name}" is your metered plan's name — choose a different name.` }, { status: 409 });
    }
    if (intent === 'create' && (await repo.comparisonNameInUse(id, name))) {
        return NextResponse.json({ error: `"${name}" already exists — use "+ add version" on that plan instead.` }, { status: 409 });
    }

    await repo.appendFixedComparison(id, { name, buyRate, sellRate, effectiveFrom });
    return NextResponse.json({ success: true });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const version = Number(body.version);
    const buyRate = Number(body.buy_rate);
    const sellRate = Number(body.sell_rate);
    const effectiveFrom = body.effective_from ? String(body.effective_from) : null;

    if (!name || !Number.isInteger(version) || !Number.isFinite(buyRate) || !Number.isFinite(sellRate)) {
        return NextResponse.json({ error: 'name, version, buy_rate and sell_rate are required' }, { status: 400 });
    }

    await new ComparisonTariffRepo().editComparisonVersion(id, name, version, { buyRate, sellRate, effectiveFrom });
    return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
        return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

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

