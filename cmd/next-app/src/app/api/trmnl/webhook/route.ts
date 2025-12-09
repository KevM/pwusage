import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';

export async function POST(request: Request) {
    try {

        const body = await request.json();
        const { user } = body;

        if (!user || !user.uuid) {
            return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 });
        }

        const service = new TrmnlService();
        await service.updateInstallation(user.uuid, user.plugin_setting_id);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
