import {pool} from './db';
import {EnergyRepo,type EnergyHistoryReader} from './energy-repo';
import {CompactHistoryStore} from './prototypes/compact-history-store';
import {CompactHistoryReader} from './prototypes/compact-history-reader';
import {withRawEnergyAccess} from './energy-storage-access';

export function compactHistoryReadsEnabled():boolean {return process.env.COMPACT_HISTORY_READS_ENABLED==='true';}

/** The flag opts unpruned sites into validation; pruned sites always require archives. */
export function createEnergyRepo(timezone:string,rawRepo?:EnergyRepo):EnergyRepo {
    const compact=new CompactHistoryReader(new CompactHistoryStore(pool),timezone);
    if(compactHistoryReadsEnabled())return new EnergyRepo(compact);
    const raw=rawRepo??new EnergyRepo();
    const read=async<T>(siteId:string,rawRead:()=>Promise<T>,compactRead:()=>Promise<T>):Promise<T>=>{
        const result=await withRawEnergyAccess([siteId],'read',rawRead);
        return result.kind==='raw'?result.value:compactRead();
    };
    const reader:EnergyHistoryReader={
        getRawEnergyData:async(site,start,end)=>read(site,()=>raw.getRawEnergyData(site,start,end),()=>compact.getRawEnergyData(site,start,end)),
        getCycleAggregates:async(site,start,end,tz)=>read(site,()=>raw.getCycleAggregates(site,start,end,tz),()=>compact.getCycleAggregates(site,start,end)),
        getBucketedEnergyData:async(site,start,end)=>read(site,()=>raw.getBucketedEnergyData(site,start,end),()=>compact.getBucketedEnergyData(site,start,end)),
        getDailyCoverage:async(site,start,end,tz)=>read(site,()=>raw.getDailyCoverage(site,start,end,tz),()=>compact.getDailyCoverage(site,start,end,tz)),
        getCycleAggregatesAndCoverage:async(site,start,end,tz)=>read(site,()=>raw.getCycleAggregatesAndCoverage(site,start,end,tz),()=>compact.getCycleAggregatesAndCoverage(site,start,end,tz)),
        getLatestEnergyData:async(site,asOf)=>read(site,()=>raw.getLatestEnergyData(site,asOf),()=>compact.getLatestEnergyData(site,asOf)),
        getLatestBatterySoc:async(site,since)=>read(site,()=>raw.getLatestBatterySoc(site,since),()=>compact.getLatestBatterySoc(site,since)),
        getLatestTimestamp:async site=>read(site,()=>raw.getLatestTimestamp(site),()=>compact.getLatestTimestamp(site)),
        hasData:async site=>read(site,()=>raw.hasData(site),()=>compact.hasData(site)),
    };
    return new EnergyRepo(reader);
}
