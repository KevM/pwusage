
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { TeslaClient } from '@/lib/tesla-client';

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
        const token = cookieStore.get('access_token')?.value;
        const refreshToken = cookieStore.get('refresh_token')?.value;

        if (!token) {
            return NextResponse.json({ error: 'Tesla token not found' }, { status: 401 });
        }

        const client = new TeslaClient({
            accessToken: token,
            refreshToken: refreshToken,
            onTokenUpdate: (newAccess, newRefresh) => {
                console.log('Refreshing tokens in Cookies from Sync API');
                cookieStore.set('access_token', newAccess, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
                cookieStore.set('refresh_token', newRefresh, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
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
