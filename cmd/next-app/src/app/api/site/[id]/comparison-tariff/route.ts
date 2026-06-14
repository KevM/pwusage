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

    if (!name || !Number.isFinite(buyRate) || !Number.isFinite(sellRate)) {
        return NextResponse.json({ error: 'name, buy_rate and sell_rate are required' }, { status: 400 });
    }

    const repo = new ComparisonTariffRepo();
    if (await repo.nameInUseByMetered(id, name)) {
        return NextResponse.json({ error: `"${name}" is your metered plan's name — choose a different name.` }, { status: 409 });
    }

    await repo.appendFixedComparison(id, { name, buyRate, sellRate, effectiveFrom });
    return NextResponse.json({ success: true });
}
