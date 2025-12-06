
import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { TeslaClient } from '@/lib/tesla-client';
import { SettingsRepo } from '@/lib/settings-repo';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const siteId = searchParams.get('siteId');
        const startParam = searchParams.get('start');
        const endParam = searchParams.get('end');

        if (!siteId || !startParam || !endParam) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
        }

        const settingsRepo = new SettingsRepo();
        const token = settingsRepo.getAccessToken();
        if (!token) {
            return NextResponse.json({ error: 'Tesla token not found' }, { status: 401 });
        }

        const client = new TeslaClient({ accessToken: token });
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

    } catch (error) {
        console.error('Sync error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
