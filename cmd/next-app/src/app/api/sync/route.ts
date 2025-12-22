
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { verifySiteToken } from '@/lib/auth-jwt';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');
        const startParam = searchParams.get('start');
        const endParam = searchParams.get('end');

        if (!siteId || !startParam || !endParam) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
        }

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;

        if (!siteAuthToken) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const siteIds = verifySiteToken(siteAuthToken);
        if (!siteIds || !siteIds.includes(siteId)) {
            return NextResponse.json({ error: 'Unauthorized site access' }, { status: 403 });
        }

        const repo = new EnergyRepo();
        const site = await repo.getSite(siteId);

        if (!site || !site.access_token) {
            return NextResponse.json({ error: 'Tesla token not found for site' }, { status: 401 });
        }

        const client = new TeslaClient({
            accessToken: site.access_token,
            refreshToken: site.refresh_token || undefined,
            tokenRefreshHandler: repo.getLockedRefreshHandler(siteId),
            onTokenUpdate: () => {
                console.log('Refreshing tokens via Sync API');
            }
        });
        const importer = new Importer(client);

        const startDate = new Date(startParam);
        const endDate = new Date(endParam);

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "checking" })}\n\n`));

                    await importer.ensureDataForRange(siteId, startDate, endDate, (msg) => {
                        const progressJson = JSON.stringify({
                            status: "progress",
                            message: msg
                        });
                        controller.enqueue(encoder.encode(`data: ${progressJson}\n\n`));
                    });

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "complete" })}\n\n`));
                    controller.close();
                } catch (err) {
                    const message = (err instanceof Error) ? err.message : String(err);
                    const errJson = JSON.stringify({ status: "error", message });
                    controller.enqueue(encoder.encode(`data: ${errJson}\n\n`));
                    controller.close();
                }
            }
        });

        return new NextResponse(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (error) {
        console.error('Sync error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
