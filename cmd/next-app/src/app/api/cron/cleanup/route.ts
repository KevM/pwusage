export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { LoadTagRepo } from '@/lib/load-tag-repo';
import { retentionDays } from '@/lib/retention';

export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const days = retentionDays();
        if (days == null) {
            // Keep-forever: full raw history is retained so the savings feature can
            // re-bucket energy into any tariff's TOU windows. Nothing to delete.
            console.log('[CRON] Cleanup skipped — data retention disabled (keep forever).');
            return NextResponse.json({ success: true, retentionDisabled: true });
        }

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const energyRepo = new EnergyRepo();
        const tagRepo = new LoadTagRepo();
        const energyResult = await energyRepo.cleanupOldEnergyData(cutoff);
        const tagResult = await tagRepo.cleanupOldTags(cutoff);
        
        const result = {
            energyDeleted: energyResult.energyDeleted,
            tagsDeleted: tagResult.tagsDeleted
        };

        console.log(`[CRON] Cleanup completed. Cutoff: ${cutoff.toISOString()}. Deleted: ${JSON.stringify(result)}`);

        return NextResponse.json({
            success: true,
            retentionDays: days,
            cutoff: cutoff.toISOString(),
            deleted: result
        });

    } catch (error) {
        console.error('[CRON] Cleanup failed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
