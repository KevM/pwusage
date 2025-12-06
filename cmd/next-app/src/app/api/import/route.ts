import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { SettingsRepo } from '@/lib/settings-repo';
import { EnergyRepo } from '@/lib/energy-repo';
import { TeslaClient } from '@/lib/tesla-client';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const granularity = searchParams.get('granularity') || 'day';
        const startParam = searchParams.get('start');
        const endParam = searchParams.get('end');

        const settingsRepo = new SettingsRepo();
        const token = settingsRepo.getAccessToken();
        const refreshToken = settingsRepo.getRefreshToken();

        if (!token) {
            return NextResponse.json({ error: 'No access token found' }, { status: 401 });
        }

        const repo = new EnergyRepo();
        const siteIds = repo.getSiteIds();

        const client = new TeslaClient({
            accessToken: token,
            refreshToken: refreshToken,
            onTokenUpdate: (newAccess, newRefresh) => {
                console.log('Refreshing tokens in DB');
                settingsRepo.setAccessToken(newAccess);
                settingsRepo.setRefreshToken(newRefresh);
            }
        });

        const importer = new Importer(client);

        // If explicit range provided, stream the progress
        if (startParam && endParam) {
            const start = new Date(startParam);
            const end = new Date(endParam);
            const encoder = new TextEncoder();

            const stream = new ReadableStream({
                async start(controller) {
                    try {
                        for (const siteId of siteIds) {
                            controller.enqueue(encoder.encode(`data: {"status":"starting", "siteId":"${siteId}"}\n\n`));

                            await importer.importRange(siteId.toString(), start, end, granularity, (date) => {
                                const progressJson = JSON.stringify({
                                    status: "progress",
                                    siteId,
                                    date: date.toISOString().split('T')[0]
                                });
                                controller.enqueue(encoder.encode(`data: ${progressJson}\n\n`));
                            });
                        }
                        controller.enqueue(encoder.encode(`data: {"status":"complete"}\n\n`));
                        controller.close();
                    } catch (err: any) {
                        const errJson = JSON.stringify({ status: "error", message: err.message });
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
        }

        // Default behavior (Worker): Auto-import limited range
        for (const siteId of siteIds) {
            console.log(`Importing site ${siteId}`);
            await importer.importSite(siteId.toString(), granularity);
        }

        return NextResponse.json({ success: true, sitesImported: siteIds.length, granularity });
    } catch (error) {
        console.error('Import error full stack:', error);
        return NextResponse.json({ error: (error as Error).message, stack: (error as Error).stack }, { status: 500 });
    }
}
