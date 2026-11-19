
import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { createTeslaClientForSite } from '@/lib/tesla-client-factory';
import { getAuthorizedSiteIds } from '@/lib/auth-checks';
import { readMobileHistoryRevision } from '@/lib/mobile-history-revision';

export const maxDuration = 60;

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

        const client = await createTeslaClientForSite(siteId, {
            onTokenUpdate: () => {
                console.log('Refreshing tokens via Sync API');
            }
        });
        if (!client) {
            return NextResponse.json({ error: 'Not authenticated or no credentials found' }, { status: 401 });
        }

        const importer = new Importer(client);

        const startDate = new Date(startParam);
        const endDate = new Date(endParam);

        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
            return NextResponse.json({ error: 'Invalid date parameters' }, { status: 400 });
        }

        // Optional: the billing period the page rendered. Its current stored-history
        // revision is reported so the client can tell whether what it shows is
        // outdated, even when another request did the import.
        const periodStart = searchParams.get('periodStart') ? new Date(searchParams.get('periodStart')!) : null;
        const periodEnd = searchParams.get('periodEnd') ? new Date(searchParams.get('periodEnd')!) : null;
        const period = periodStart && periodEnd && Number.isFinite(+periodStart) && Number.isFinite(+periodEnd) && periodStart < periodEnd
            ? { start: periodStart, end: periodEnd }
            : null;
        const readPeriodRevision = async (): Promise<{ historyRevision?: string }> => {
            if (!period) return {};
            try {
                return { historyRevision: (await readMobileHistoryRevision(siteId, period.start, period.end)).revision };
            } catch (error) {
                console.warn('[sync] history revision unavailable:', error);
                return {};
            }
        };

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                // Days rewritten so far, reported on every terminal event (even an
                // error after some days were written) so the client refreshes only
                // when stored history really changed.
                const changedDays: string[] = [];
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "checking" })}\n\n`));

                    const result = await importer.ensureDataForRange(
                        siteId,
                        startDate,
                        endDate,
                        (msg) => {
                            const progressJson = JSON.stringify({
                                status: "progress",
                                message: msg
                            });
                            controller.enqueue(encoder.encode(`data: ${progressJson}\n\n`));
                        },
                        { maxTimeMs: 40000, onDayChanged: day => { changedDays.push(day.toISOString()); } }
                    );

                    if (result.complete) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "complete", changedDays, ...await readPeriodRevision() })}\n\n`));
                    } else {
                        const message = result.processedWindows > 0
                            ? `Synced ${result.processedWindows} days, continuing...`
                            : 'Import busy, waiting for lock...';
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                            status: "partial",
                            message,
                            processedWindows: result.processedWindows,
                            totalWindows: result.totalWindows,
                            changedDays,
                            ...await readPeriodRevision()
                        })}\n\n`));
                    }
                    controller.close();
                } catch (err) {
                    const message = (err instanceof Error) ? err.message : String(err);
                    const errJson = JSON.stringify({ status: "error", message, changedDays, ...await readPeriodRevision() });
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
