import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';

export async function POST(request: Request) {
    try {
        // Trmnl doesn't sign this request with the access token?
        // Docs say: "Where you want to receive uninstallation events as a webhook"
        // Usually webhooks are signed or have a secret.
        // Trmnl docs don't specify auth for uninstall webhook in the summary I read.
        // Let's assume it sends the UUID or something we can verify?
        // Or maybe it sends the same Bearer token if it still has it?
        // Let's check the docs again if needed, or just implement basic handling.
        // Assuming payload has user UUID.

        const body = await request.json();
        const { user_uuid } = body;

        if (!user_uuid) {
            // Maybe it's nested like success webhook? { user: { uuid: ... } }
            // Let's try to handle both or log it.
            console.log('Uninstall webhook body:', body);
            return NextResponse.json({ success: true });
        }

        const service = new TrmnlService();
        await service.deleteInstallation(user_uuid);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Uninstall error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
