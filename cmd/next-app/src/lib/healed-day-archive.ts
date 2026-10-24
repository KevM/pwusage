import {pool} from './db';
import {addDaysInSiteTimezone} from './date-utils';
import {HistoryArchiveRepo} from './history-archive-repo';
import {archiveCutoff,readArchiveOptions,type ArchiveCandidate,type ArchiveJobRepo,type ArchiveControl} from './history-archive-service';
import type {DateWindow} from './importer/import-planner';

export interface HealedDayArchiveRepo extends Pick<ArchiveJobRepo,'finalize'|'trim'> {
    healControl(day:ArchiveCandidate):Promise<ArchiveControl|null>;
}
export type HealedDayStatus='archived'|'trimmed'|'skipped'|'busy'|'empty'|'incomplete-attribution'|'failed'|'deferred';

/**
 * Put days that a heal or sync just re-imported from Tesla back into the
 * archive when they are past the retention cutoff, instead of leaving them as
 * raw rows until the archive job comes round. Mirrors one day of
 * `runHistoryArchive` (same cohort, pause, trim-mode and attribution rules)
 * without its job claim; best effort, since the job remains the backstop. Days
 * left when `deadline` (a `clock` time) passes are deferred to that job.
 */
export async function archiveHealedDays(
    site:{id:string;timezone:string},
    days:DateWindow[],
    now:Date,
    deps:{repo?:HealedDayArchiveRepo;env?:NodeJS.ProcessEnv;deadline?:number;clock?:()=>number}={}
):Promise<{start:string;status:HealedDayStatus}[]> {
    let options;
    try {options=readArchiveOptions(deps.env??process.env,now);}
    catch(error) {console.error('[HealedDayArchive] invalid archive configuration',error);return [];}
    const cutoff=archiveCutoff(now,site.timezone,options.retentionDays);
    const old=days.filter(d=>d.end<=cutoff);
    if(!old.length)return [];
    const repo=deps.repo??new HistoryArchiveRepo(pool);
    const results:{start:string;status:HealedDayStatus}[]=[];
    const clock=deps.clock??Date.now;
    for(const window of old) {
        if(deps.deadline!==undefined&&clock()>=deps.deadline) {
            results.push({start:window.start.toISOString(),status:'deferred'});continue;
        }
        const day:ArchiveCandidate={siteId:site.id,timezone:site.timezone,start:window.start,end:addDaysInSiteTimezone(window.start,1,site.timezone)};
        let status:HealedDayStatus='failed';
        try {
            const control=await repo.healControl(day);
            if(!control)status='skipped';
            else {
                const finalized=await repo.finalize(day,now,control);
                if(finalized.status==='busy'||finalized.status==='empty')status=finalized.status;
                else if(!finalized.revision)throw new Error('Missing verified revision');
                else if(!control.trim||!options.readsEnabled)status='archived';
                else if(!finalized.attributionComplete)status='incomplete-attribution';
                else {
                    const trimmed=await repo.trim(day,finalized.revision,now,control);
                    if(trimmed.status==='busy')status='busy';
                    else if(trimmed.status==='trimmed'||trimmed.status==='already-trimmed')status='trimmed';
                    else throw new Error('Unexpected trim result');
                }
            }
        } catch(error) {
            console.error(`[HealedDayArchive] site ${site.id} day ${window.start.toISOString()} failed`,error);
        }
        results.push({start:window.start.toISOString(),status});
    }
    return results;
}
