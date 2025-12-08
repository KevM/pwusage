import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { EnergyRepo } from '@/lib/energy-repo';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { code, site_id, uuid } = body;

        if (!code || !site_id) {
            return NextResponse.json({ error: 'Missing code or site_id' }, { status: 400 });
        }

        // TODO: Get these from env vars or settings
        const clientId = process.env.TRMNL_CLIENT_ID;
        const clientSecret = process.env.TRMNL_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            return NextResponse.json({ error: 'Server misconfigured: Missing Trmnl credentials' }, { status: 500 });
        }

        const cookieStore = await cookies();
        const refreshToken = cookieStore.get('refresh_token')?.value;

        // Save installation
        const service = new TrmnlService();
        const repo = new EnergyRepo(); // For site updates

        const accessToken = await service.exchangeCodeForToken(code, clientId, clientSecret);

        // Create installation (we still might want to store refresh_token in installation for redundancy?
        // No, we decided to centralized. But TrmnlService expects it?
        // Let's keep it in TrmnlInstallation for now to avoid breaking changes in service,
        // BUT the markup route will ignore it.
        // Ideally we should remove it from TrmnlInstallation eventually.
        // However, for this step, CRITICAL is to update the SITE table.

        // Update signature: accessToken, siteId, uuid, refreshToken
        await service.createInstallation(accessToken, site_id, uuid, refreshToken);

        // update Site tokens (Source of Truth)
        await repo.updateSiteTokens(site_id, accessToken, refreshToken || '');

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Setup error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
