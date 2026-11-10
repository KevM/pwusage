export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifySiteAccess } from '@/lib/auth-checks';
import { TrmnlService } from '@/lib/trmnl-service';
import { toTrmnlDevices } from '@/lib/trmnl-devices';

/** The Trmnl devices connected to a site. Shared by the web settings page and the iOS app. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!(await verifySiteAccess(id))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const installations = await new TrmnlService().getInstallationsBySiteId(id, { includeTokens: false });
    return NextResponse.json(
        { devices: toTrmnlDevices(installations) },
        { headers: { 'Cache-Control': 'private, no-store' } }
    );
}
