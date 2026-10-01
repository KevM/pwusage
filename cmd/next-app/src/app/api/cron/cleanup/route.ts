export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { HistoryRetentionService } from '@/lib/history-retention-service';

export async function GET(request: NextRequest) {
    try {
        const secret = process.env.CRON_SECRET;
        if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        // Activation is a separate rollout step after notice, grace bootstrap, backup, and preview.
        if (process.env.RETENTION_CLEANUP_ENABLED !== 'true') {
            return NextResponse.json({ success: true, enabled: false, disabledReason: 'Retention cleanup has not been activated' });
        }
        const report = await new HistoryRetentionService().run({ apply: true });
        console.log('[CRON] Retention cleanup:', JSON.stringify({ enabled: report.enabled, deleted: report.deleted, batches: report.batches, workRemaining: report.workRemaining, skippedSites: report.skippedSites.length }));
        return NextResponse.json({ success: true, ...report });
    } catch (error) {
        console.error('[CRON] Cleanup failed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
