import type {Pool} from 'pg';
import {CompactHistoryStore} from './prototypes/compact-history-store';
import type {ArchiveMutationResult} from './prototypes/compact-history-store';
export interface RestoreDay {siteId:string;start:string;revision:string}
export interface RestorePlan {version:1;days:RestoreDay[]}
export interface HistoryRecoveryRepo {
    restore(day:RestoreDay):Promise<ArchiveMutationResult>;
    remaining():Promise<number>;
}
export function parseRestorePlan(input:unknown):RestorePlan {
    if(typeof input!=='object'||input===null||!('version' in input)||input.version!==1||!('days' in input)||!Array.isArray(input.days)
        ||input.days.length<1||input.days.length>7)throw new Error('Expected 1–7 reviewed restoration days');
    const keys=new Set<string>();
    const days:RestoreDay[]=input.days.map((day:unknown)=>{
        if(typeof day!=='object'||day===null||!('siteId' in day)||typeof day.siteId!=='string'||!day.siteId.trim()||day.siteId.length>200
            ||!('start' in day)||typeof day.start!=='string'||!Number.isSafeInteger(+new Date(day.start))||new Date(day.start).toISOString()!==day.start
            ||!('revision' in day)||typeof day.revision!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(day.revision))throw new Error('Invalid reviewed restoration day');
        const key=JSON.stringify([day.siteId,day.start]);
        if(keys.has(key))throw new Error('Duplicate restoration day');keys.add(key);
        return {siteId:day.siteId,start:day.start,revision:day.revision};
    });
    return {version:1,days};
}
export async function restoreHistoryPlan(repo:HistoryRecoveryRepo,plan:RestorePlan,clock:()=>number=()=>performance.now()) {
    const reviewed=parseRestorePlan(plan);const started=clock();
    const days:(RestoreDay&ArchiveMutationResult)[]=[];
    let stopped:'complete'|'time-budget'|'busy'='complete';
    for(const day of reviewed.days) {
        if(clock()-started>=30000) {stopped='time-budget';break;}
        const result=await repo.restore(day);days.push({...day,...result});
        if(result.status==='busy') {stopped='busy';break;}
    }
    return {days,stopped,remainingPrunedDays:await repo.remaining()};
}

/** Operator recovery uses the same lossless revision protocol as import repair. */
export class HistoryArchiveRecoveryRepo implements HistoryRecoveryRepo {
    private readonly store:CompactHistoryStore;
    constructor(private readonly pool:Pool) {
        this.store=new CompactHistoryStore(pool,15000,async client=>{
            // Hold the pause row through COMMIT, so resume cannot race restore.
            const result=await client.query<{paused:boolean}>('SELECT paused FROM "HistoryArchiveControl" WHERE id=true FOR SHARE');
            if(result.rows[0]?.paused!==true)throw new Error('Pause the archive job before restoration');
        });
    }
    restore(day:RestoreDay):Promise<ArchiveMutationResult> {
        return this.store.restoreDay(day.siteId,new Date(day.start),day.revision);
    }
    async remaining():Promise<number> {
        return Number((await this.pool.query<{n:string}>('SELECT count(*) AS n FROM "EnergyDayArchive" WHERE raw_pruned')).rows[0].n);
    }
    async preview(sites:string[]|null):Promise<RestorePlan&{remainingPrunedDays:number}> {
        const result=await this.pool.query<{siteId:string;start:Date;revision:string}>(`SELECT site_id AS "siteId",day_start AS start,revision
            FROM "EnergyDayArchive" WHERE raw_pruned AND ($1::text[] IS NULL OR site_id=ANY($1)) ORDER BY site_id,day_start LIMIT 7`,[sites]);
        return {version:1,days:result.rows.map(day=>({...day,start:day.start.toISOString()})),remainingPrunedDays:await this.remaining()};
    }
}
