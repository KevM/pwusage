import { NextResponse } from 'next/server';
import { TrmnlService } from '@/lib/trmnl-service';
import { db } from '@/lib/db';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const uuid = searchParams.get('uuid');

    if (!uuid) {
        return NextResponse.json({ error: 'Missing UUID' }, { status: 400 });
    }

    const service = new TrmnlService();
    const installation = service.getInstallationByUuid(uuid);

    if (!installation) {
        return NextResponse.json({ error: 'Installation not found' }, { status: 404 });
    }

    return NextResponse.json({ site_id: installation.site_id });
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { uuid, site_id } = body;

        if (!uuid || !site_id) {
            return NextResponse.json({ error: 'Missing uuid or site_id' }, { status: 400 });
        }

        // We need to update the site_id for this installation.
        // TrmnlService doesn't have a method for just updating site_id by uuid.
        // Let's add it or do it directly here.
        // Direct DB call for simplicity since we are in API route.

        db.prepare('UPDATE TrmnlInstallation SET site_id = ? WHERE uuid = ?').run(site_id, uuid);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Manage error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
