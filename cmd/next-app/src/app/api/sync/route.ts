
import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { TeslaClient } from '@/lib/tesla-client';
import { EnergyRepo } from '@/lib/energy-repo';
import { getTeslaCredentials, getAuthorizedSiteIds } from '@/lib/auth-checks';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');
        const startParam = searchParams.get('start');
        const endParam = searchParams.get('end');

        if (!siteId || !startParam || !endParam) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
        }

        const authorizedSites = await getAuthorizedSiteIds();
        if (!authorizedSites.includes(siteId)) {
            return NextResponse.json({ error: 'Unauthorized site access' }, { status: 403 });
        }

        const credentials = await getTeslaCredentials();
        if (!credentials) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const repo = new EnergyRepo();
        const client = new TeslaClient({
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token || undefined,
            tokenRefreshHandler: repo.getLockedRefreshHandler(siteId), // Can we use siteId specific lock? Yes, credentials are User-wide, but lock is by User ID which getLockedRefreshHandler handles if site is linked to User.
            // Wait, getLockedRefreshHandler(siteId) -> getSite(siteId) -> gets User.
            // Since we validated request for siteId, passing siteId is correct.
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
