import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';

export async function POST(request: Request) {
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 });
        }

        const accessToken = authHeader.split(' ')[1];
        const body = await request.json();
        const { user } = body;

        if (!user || !user.uuid) {
            return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 });
        }

        const service = new TrmnlService();
        await service.updateInstallation(accessToken, user.uuid, user.plugin_setting_id);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
