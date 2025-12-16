import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { user_uuid } = body;

        if (!user_uuid) {
            console.error('Uninstall webhook missing user_uuid:', body);
            // Return 200 to acknowledge webhook reception even if payload is bad, or 400?
            // Trmnl retries on 500. 400 is probably best.
            return NextResponse.json({ error: 'Missing user_uuid' }, { status: 400 });
        }

        const service = new TrmnlService();
        const installation = await service.getInstallationByUuid(user_uuid);

        if (!installation) {
            console.log(`[TrmnlUninstall] Installation not found for UUID ${user_uuid}. Already deleted?`);
            // Idempotent success
            return NextResponse.json({ success: true });
        }

        // Verify Bearer Token
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.warn(`[TrmnlUninstall] Missing Bearer token for UUID ${user_uuid}`);
            return NextResponse.json({ error: 'Unauthorized: Missing Bearer token' }, { status: 401 });
        }

        const token = authHeader.split(' ')[1];
        if (installation.access_token && token !== installation.access_token) {
            console.warn(`[TrmnlUninstall] Invalid Bearer token for UUID ${user_uuid}`);
            return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
        }

        // Proceed to delete
        console.log(`[TrmnlUninstall] Deleting installation for UUID ${user_uuid}`);
        await service.deleteInstallation(user_uuid);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Uninstall error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
