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

        // Update Site tokens (Source of Truth)
        await repo.updateSiteTokens(site_id, accessToken, refreshToken || '');

        // Create/Update installation with Site ID and UUID
        // We do not store tokens here anymore.
        await service.createInstallation(site_id, uuid);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Setup error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
