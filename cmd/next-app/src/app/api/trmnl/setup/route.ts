import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { code, site_id } = body;

        if (!code || !site_id) {
            return NextResponse.json({ error: 'Missing code or site_id' }, { status: 400 });
        }

        // TODO: Get these from env vars or settings
        const clientId = process.env.TRMNL_CLIENT_ID;
        const clientSecret = process.env.TRMNL_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            return NextResponse.json({ error: 'Server misconfigured: Missing Trmnl credentials' }, { status: 500 });
        }

        const service = new TrmnlService();
        const accessToken = await service.exchangeCodeForToken(code, clientId, clientSecret);
        await service.createInstallation(accessToken, site_id);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Setup error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
