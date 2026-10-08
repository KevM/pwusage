export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { CompactHistoryStore } from '@/lib/prototypes/compact-history-store';
import { compactHistoryReadsEnabled } from '@/lib/energy-repo-factory';

export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get('authorization');
        const cronSecret = process.env.CRON_SECRET;
        if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if(compactHistoryReadsEnabled()) {
            return NextResponse.json({success:true,skipped:true,reason:'compact-history-maintenance-required'});
        }

        const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '365', 10);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);

        const cleanup = await new CompactHistoryStore(pool).cleanupLegacyHistory(cutoff);
        if(cleanup.skipped) {
            return NextResponse.json({success:true,skipped:true,reason:'compact-history-maintenance-required'});
        }
        const result = {energyDeleted:cleanup.energyDeleted,tagsDeleted:cleanup.tagsDeleted};

        console.log(`[CRON] Cleanup completed. Cutoff: ${cutoff.toISOString()}. Deleted: ${JSON.stringify(result)}`);

        return NextResponse.json({
            success: true,
            retentionDays,
            cutoff: cutoff.toISOString(),
            deleted: result
        });

    } catch (error) {
        console.error('[CRON] Cleanup failed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
