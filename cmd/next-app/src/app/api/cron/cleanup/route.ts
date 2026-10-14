export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import {NextRequest,NextResponse} from 'next/server';
import {pool} from '@/lib/db';
import {HistoryArchiveRepo} from '@/lib/history-archive-repo';
import {readArchiveOptions,runHistoryArchive} from '@/lib/history-archive-service';

/** Retains the existing daily cron URL; legacy deletion is permanently retired. */
export async function GET(request:NextRequest) {
    const secret=process.env.CRON_SECRET;
    if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`) {
        return NextResponse.json({error:'Unauthorized'},{status:401});
    }
    if(process.env.HISTORY_ARCHIVE_JOB_ENABLED!=='true') {
        return NextResponse.json({success:true,skipped:true,reason:'archive-job-disabled'});
    }
    try {
        const archive=await runHistoryArchive(new HistoryArchiveRepo(pool),readArchiveOptions(process.env));
        console.log('[CRON] History archive',JSON.stringify({stopped:archive.stopped,days:archive.days.length,
            statuses:archive.days.map(d=>d.status),estimatedBytes:archive.estimatedBytes}));
        return NextResponse.json({success:true,archive});
    } catch {
        console.error('[CRON] History archive failed; raw history retained for retry');
        return NextResponse.json({error:'Internal Server Error'},{status:500});
    }
}
