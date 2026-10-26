import { logEvent, observeRoute, setLogContext } from '@/lib/observability';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import {NextRequest,NextResponse} from 'next/server';
import {pool} from '@/lib/db';
import {HistoryArchiveRepo} from '@/lib/history-archive-repo';
import {readArchiveOptions,runHistoryArchive} from '@/lib/history-archive-service';

/** Retains the existing daily cron URL; legacy deletion is permanently retired. */
async function handleGET(request:NextRequest) {
    const secret=process.env.CRON_SECRET;
    if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`) {
        return NextResponse.json({error:'Unauthorized'},{status:401});
    }
    if(process.env.HISTORY_ARCHIVE_JOB_ENABLED!=='true') {
        return NextResponse.json({success:true,skipped:true,reason:'archive-job-disabled'});
    }
    try {
        const archive=await runHistoryArchive(new HistoryArchiveRepo(pool),readArchiveOptions(process.env));
        setLogContext({ siteIds: archive.days.map(day => day.siteId) });
        logEvent('info', 'cron.archive.completed', { stopped: archive.stopped, days: archive.days.length, estimatedBytes: archive.estimatedBytes });
        console.log('[CRON] History archive',JSON.stringify({stopped:archive.stopped,days:archive.days.length,
            statuses:archive.days.map(d=>d.status),estimatedBytes:archive.estimatedBytes}));
        return NextResponse.json({success:true,archive});
    } catch (error) {
        logEvent('error', 'cron.archive.failed', { error });
        return NextResponse.json({error:'Internal Server Error'},{status:500});
    }
}

export const GET = observeRoute('/api/cron/cleanup', handleGET);
