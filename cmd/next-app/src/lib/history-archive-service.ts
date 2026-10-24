import {addDaysInSiteTimezone,getSiteMidnight} from './date-utils';
import type {ArchiveMutationResult,FinalizationResult} from './prototypes/compact-history-store';

/** `trim`: the site is in the trim cohort and the day is past trim retention (set by `next`). */
export interface ArchiveCandidate {siteId:string;start:Date;end:Date;timezone:string;trim?:boolean}
export interface ArchiveControl {paused:boolean;trim:boolean;revision:string}
/** `trimSite`: trim mode is on and this day is in the listed trim cohort and its date bounds. */
export type HealControl=ArchiveControl&{trimSite:boolean};
/**
 * `archiveAfterDays` (floor 2) is when a finished day is archived; `retentionDays`
 * is only how long raw rows are kept before trim mode deletes them.
 */
export interface ArchiveOptions {now:Date;retentionDays:number;archiveAfterDays:number;maxDays:number;maxTimeMs:number;maxEstimatedBytes:number;readsEnabled:boolean}
export type ArchiveDayStatus='archived'|'trimmed'|'empty'|'busy'|'incomplete-attribution'|'failed'|'source-too-large';
export interface ArchiveReport {
    days:{siteId:string;start:string;status:ArchiveDayStatus;samples?:number}[];
    stopped:'paused'|'busy'|'readers-disabled'|'mode-changed'|'control-changed'|'day-budget'|'time-budget'|'byte-budget'|'caught-up';
    estimatedBytes:number;retentionDays:number;archiveAfterDays:number;teslaRequests:0;
}
export interface ArchiveJobRepo {
    claim():Promise<boolean>;release():Promise<void>;control():Promise<ArchiveControl>;
    next(retentionDays:number,archiveAfterDays:number,now:Date,preferRetry?:boolean):Promise<ArchiveCandidate|null>;
    estimate(day:ArchiveCandidate,trim:boolean):Promise<number>;
    finalize(day:ArchiveCandidate,now:Date,control:ArchiveControl):Promise<FinalizationResult>;
    trim(day:ArchiveCandidate,revision:string,now:Date,control:ArchiveControl):Promise<ArchiveMutationResult>;
    retry(day:ArchiveCandidate,reason:ArchiveDayStatus,now:Date):Promise<void>;
    clearRetry(day:ArchiveCandidate):Promise<void>;saveReport(report:ArchiveReport):Promise<void>;
}
export class ArchiveControlChangedError extends Error {
    constructor() {super('Archive control changed before mutation');}
}
const CONTROL_BYTES=32768;
function integer(value:string|undefined,fallback:number,max:number,min=1):number {
    if(value!==undefined&&!/^[1-9]\d*$/.test(value))throw new Error('Invalid archive job configuration');
    const n=value===undefined?fallback:Number(value);
    if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('Invalid archive job configuration');return n;
}
export function readArchiveOptions(env:NodeJS.ProcessEnv,now=new Date()):ArchiveOptions {
    return {now,retentionDays:integer(env.DATA_RETENTION_DAYS,365,36500),archiveAfterDays:integer(env.HISTORY_ARCHIVE_AFTER_DAYS,2,36500,2),maxDays:integer(env.HISTORY_ARCHIVE_MAX_DAYS,2,7),
        maxTimeMs:integer(env.HISTORY_ARCHIVE_MAX_TIME_MS,30000,30000),maxEstimatedBytes:integer(env.HISTORY_ARCHIVE_MAX_ESTIMATED_BYTES,4*1024*1024,64*1024*1024),
        readsEnabled:env.COMPACT_HISTORY_READS_ENABLED==='true'};
}
function validate(options:ArchiveOptions):void {
    if(!Number.isSafeInteger(+options.now))throw new Error('Invalid archive clock');
    for(const [n,max,min] of [[options.retentionDays,36500,1],[options.archiveAfterDays,36500,2],[options.maxDays,7,1],[options.maxTimeMs,30000,1],[options.maxEstimatedBytes,64*1024*1024,1]]) {
        if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('Invalid archive job budget');
    }
}
export function archiveCutoff(now:Date,timezone:string,retentionDays:number):Date {
    const midnight=getSiteMidnight(now,timezone);
    return addDaysInSiteTimezone(midnight,-Math.max(retentionDays,2),timezone);
}
export async function runHistoryArchive(repo:ArchiveJobRepo,options:ArchiveOptions,clock:()=>number=()=>performance.now()):Promise<ArchiveReport> {
    validate(options);const started=clock();
    const report:ArchiveReport={days:[],stopped:'day-budget',estimatedBytes:0,retentionDays:options.retentionDays,archiveAfterDays:options.archiveAfterDays,teslaRequests:0};
    if(!await repo.claim())return {...report,stopped:'busy'};
    try {
        for(let i=0;i<options.maxDays;i++) {
            if(clock()-started>=options.maxTimeMs) {report.stopped='time-budget';break;}
            if(report.estimatedBytes+CONTROL_BYTES>options.maxEstimatedBytes) {report.stopped='byte-budget';break;}
            report.estimatedBytes+=CONTROL_BYTES;
            const control=await repo.control();
            if(control.paused) {report.stopped='paused';break;}
            if(control.trim&&!options.readsEnabled) {report.stopped='readers-disabled';break;}
            const day=await repo.next(options.retentionDays,options.archiveAfterDays,options.now,i%2===1);
            if(!day) {report.stopped='caught-up';break;}
            if(clock()-started>=options.maxTimeMs) {report.stopped='time-budget';break;}
            let status:ArchiveDayStatus='failed';let samples:number|undefined;
            try {
                if(+day.start!==+getSiteMidnight(day.start,day.timezone)
                    ||+day.end!==+addDaysInSiteTimezone(day.start,1,day.timezone)
                    ||day.end>archiveCutoff(options.now,day.timezone,options.archiveAfterDays))throw new Error('Ineligible archive day');
                // Trim only what the repo marked (listed trim cohort) and only past retention.
                const trimDay=control.trim&&day.trim===true&&day.end<=archiveCutoff(options.now,day.timezone,options.retentionDays);
                const estimated=await repo.estimate(day,trimDay);
                if(!Number.isSafeInteger(estimated)||estimated<0)throw new Error('Invalid transfer estimate');
                if(estimated+CONTROL_BYTES>options.maxEstimatedBytes) {status='source-too-large';report.stopped='byte-budget';}
                else if(report.estimatedBytes+estimated>options.maxEstimatedBytes) {report.stopped='byte-budget';break;}
                else {
                    if(clock()-started>=options.maxTimeMs) {report.stopped='time-budget';break;}
                    const latestBeforeArchive=await repo.control();
                    if(latestBeforeArchive.paused||latestBeforeArchive.trim!==control.trim||latestBeforeArchive.revision!==control.revision) {report.stopped=latestBeforeArchive.paused?'paused':latestBeforeArchive.trim!==control.trim?'mode-changed':'control-changed';break;}
                    if(clock()-started>=options.maxTimeMs) {report.stopped='time-budget';break;}
                    report.estimatedBytes+=estimated;
                    const result=await repo.finalize(day,options.now,control);
                    if(result.status==='busy'||result.status==='empty')status=result.status;
                    else if(!result.revision)throw new Error('Missing verified revision');
                    else {
                        status='archived';
                        if(trimDay) {
                            const latest=await repo.control();
                            if(latest.paused||!latest.trim||latest.revision!==control.revision) {report.days.push({siteId:day.siteId,start:day.start.toISOString(),status});report.stopped=latest.paused?'paused':!latest.trim?'mode-changed':'control-changed';break;}
                            if(clock()-started>=options.maxTimeMs) {report.days.push({siteId:day.siteId,start:day.start.toISOString(),status});report.stopped='time-budget';break;}
                            if(!result.attributionComplete)status='incomplete-attribution';
                            else {
                                const trim=await repo.trim(day,result.revision,options.now,control);
                                if(trim.status==='busy')status='busy';
                                else if(trim.status==='trimmed'||trim.status==='already-trimmed') {status='trimmed';samples=trim.samples;}
                                else throw new Error('Unexpected trim result');
                            }
                        }
                    }
                }
            } catch(error) {
                if(error instanceof ArchiveControlChangedError) {
                    if(status==='archived')report.days.push({siteId:day.siteId,start:day.start.toISOString(),status});
                    report.stopped='control-changed';break;
                }
                status='failed';
            }
            if(['busy','failed','incomplete-attribution','source-too-large'].includes(status))await repo.retry(day,status,options.now);
            else await repo.clearRetry(day);
            report.days.push({siteId:day.siteId,start:day.start.toISOString(),status,...(samples===undefined?{}:{samples})});
            if(status==='source-too-large')break;
        }
        await repo.saveReport(report);return report;
    } finally {
        // The repository destroys the claim connection even if rollback fails.
        // Cleanup must not replace saved progress or the original work error.
        try {await repo.release();}
        catch {console.warn('[CRON] History archive claim cleanup failed; connection discarded');}
    }
}
