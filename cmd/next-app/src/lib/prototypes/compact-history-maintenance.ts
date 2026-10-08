import type {DailyCoverageStat} from '../energy-repo';
import {auditDays} from '../importer/import-planner';
import {formatSiteDate} from '../date-utils';
import type {FinalizationResult} from './compact-history-store';

export interface MaintenanceOptions {
    siteId:string;from:string;before:string;apply?:boolean;rebuild?:boolean;maxDays?:number;maxTimeMs?:number;now?:Date;
}
export interface MaintenanceSnapshot {
    timezone:string;start:Date;end:Date;coverage:DailyCoverageStat[];
    archives:{start:Date;attributionComplete:boolean;rawPruned?:boolean}[];
}
export interface MaintenanceStore {
    getMaintenanceSnapshot(siteId:string,from:string,before:string,rebuild:boolean,now:Date):Promise<MaintenanceSnapshot>;
    finalizeDay(siteId:string,start:Date,now:Date):Promise<FinalizationResult>;
}
export interface MaintenanceDay {
    date:string;rawPruned:boolean;samples:number;expectedSamples:number;needsRepair:boolean;attributionComplete:boolean|null;
    status:'pending'|'archived'|'empty'|FinalizationResult['status'];
}
export interface MaintenanceReport {
    mode:'preview'|'apply';days:MaintenanceDay[];remaining:string[];stopped:'busy'|'time-budget'|'day-budget'|null;
    rawDataRetained:boolean;rawDeletionPerformed:false;teslaRequests:0;
}
export function validateMaintenanceDates(from:string,before:string):void {
    for(const date of [from,before]) {
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Expected local YYYY-MM-DD dates');
        const parsed=new Date(`${date}T00:00:00Z`);
        if(!Number.isSafeInteger(+parsed)||parsed.toISOString().slice(0,10)!==date)throw new Error('Invalid local date');
    }
    if(from>=before)throw new Error('Expected a nonempty forward date range');
}
export function validateMaintenanceOptions(options:MaintenanceOptions):void {
    validateMaintenanceDates(options.from,options.before);
    if(!options.siteId?.trim()||options.siteId.length>200)throw new Error('Explicit site ID required');
    const maxDays=options.maxDays??7,maxTimeMs=options.maxTimeMs??45000;
    if(!Number.isInteger(maxDays)||maxDays<1||maxDays>7||!Number.isInteger(maxTimeMs)||maxTimeMs<1||maxTimeMs>45000)throw new Error('Invalid maintenance budget');
    if(options.now&&!Number.isSafeInteger(+options.now))throw new Error('Invalid maintenance clock');
}
export async function runCompactMaintenance(store:MaintenanceStore,options:MaintenanceOptions,clock:()=>number=()=>performance.now()):Promise<MaintenanceReport> {
    validateMaintenanceOptions(options);
    const started=clock(),now=options.now??new Date(),rebuild=options.rebuild??false;
    const snapshot=await store.getMaintenanceSnapshot(options.siteId,options.from,options.before,rebuild,now);
    const archived=new Map(snapshot.archives.map(a=>[+a.start,a]));
    const audits=auditDays({requestedRange:{start:snapshot.start,end:snapshot.end},existingCoverage:snapshot.coverage,timezone:snapshot.timezone,now});
    const days:MaintenanceDay[]=audits.map(day=>{
        const archive=archived.get(+day.windowStart);
        const expectedSamples=(+day.windowEnd-+day.windowStart)/300000;
        return {date:formatSiteDate(day.windowStart,snapshot.timezone),rawPruned:archive?.rawPruned??false,samples:day.count,expectedSamples,
            needsRepair:day.count!==expectedSamples||day.missingStart||day.missingEnd||day.hasInteriorGap||archive?.attributionComplete===false,
            attributionComplete:archive?.attributionComplete??null,
            status:archive&&!rebuild?'archived':day.count===0?'empty':'pending'};
    });
    let attempted=0;let stopped:MaintenanceReport['stopped']=null;
    if(options.apply) for(let i=0;i<days.length;i++) {
        if(days[i].status!=='pending')continue;
        if(attempted>=(options.maxDays??7)) {stopped='day-budget';break;}
        if(clock()-started>=(options.maxTimeMs??45000)) {stopped='time-budget';break;}
        const result=await store.finalizeDay(options.siteId,audits[i].windowStart,now);attempted++;
        days[i].status=result.status;
        if(result.attributionComplete!==undefined) {
            days[i].attributionComplete=result.attributionComplete;
            days[i].needsRepair ||= !result.attributionComplete;
        }
        if(result.status==='busy') {stopped='busy';break;}
    }
    return {mode:options.apply?'apply':'preview',days,remaining:days.filter(d=>d.status==='pending'||d.status==='busy').map(d=>d.date),stopped,rawDataRetained:!snapshot.archives.some(a=>a.rawPruned),rawDeletionPerformed:false,teslaRequests:0};
}
export function parseMaintenanceArgs(args:string[]):MaintenanceOptions {
    const values=new Map<string,string>();const flags=new Set<string>();
    for(let i=0;i<args.length;i++) {
        const key=args[i];
        if(values.has(key)||flags.has(key))throw new Error('Duplicate argument');
        if(key==='--apply'||key==='--rebuild') {flags.add(key);continue;}
        if(!['--site-id','--from','--before','--max-days'].includes(key)||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Unknown or missing argument');
        values.set(key,args[++i]);
    }
    const max=values.get('--max-days');if(max&&!/^\d+$/.test(max))throw new Error('Invalid day budget');
    const result={siteId:values.get('--site-id')??'',from:values.get('--from')??'',before:values.get('--before')??'',apply:flags.has('--apply'),rebuild:flags.has('--rebuild'),maxDays:max?Number(max):7};
    validateMaintenanceOptions(result);return result;
}
