import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { SiteRoiConfigRepo } from '@/lib/roi/roi-config-repo';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const body = await request.json();
    const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
    const str = (v: unknown) => (v === '' || v == null ? null : String(v));
    await new SiteRoiConfigRepo().upsert({
        site_id: id,
        solar_cost: num(body.solar_cost),
        solar_install_date: str(body.solar_install_date),
        battery_cost: num(body.battery_cost),
        battery_install_date: str(body.battery_install_date),
        fixed_buy_rate: null,
        fixed_sell_rate: null,
    });
    return NextResponse.json({ success: true });
}
