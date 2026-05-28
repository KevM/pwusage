export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { LoadTagRepo } from '@/lib/load-tag-repo';
import { log } from '@/lib/log';
import { withLog } from '@/lib/with-log';
import { pingHeartbeat } from '@/lib/heartbeat';

export const GET = withLog(async (request: NextRequest) => {
    try {
        const authHeader = request.headers.get('authorization');
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || '365', 10);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);

        const energyRepo = new EnergyRepo();
        const tagRepo = new LoadTagRepo();
        const energyResult = await energyRepo.cleanupOldEnergyData(cutoff);
        const tagResult = await tagRepo.cleanupOldTags(cutoff);

        const result = {
            energyDeleted: energyResult.energyDeleted,
            tagsDeleted: tagResult.tagsDeleted
        };

        log.info(`[CRON] Cleanup completed. Cutoff: ${cutoff.toISOString()}. Deleted: ${JSON.stringify(result)}`, {
            cutoff: cutoff.toISOString(),
            ...result,
        });

        await pingHeartbeat('cleanup');

        return NextResponse.json({
            success: true,
            retentionDays,
            cutoff: cutoff.toISOString(),
            deleted: result
        });

    } catch (error) {
        log.error('[CRON] Cleanup failed', {
            err: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
