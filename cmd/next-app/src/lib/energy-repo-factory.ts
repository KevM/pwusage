import {pool} from './db';
import {EnergyRepo} from './energy-repo';
import {CompactHistoryStore} from './prototypes/compact-history-store';
import {CompactHistoryReader} from './prototypes/compact-history-reader';

export function compactHistoryReadsEnabled():boolean {return process.env.COMPACT_HISTORY_READS_ENABLED==='true';}

/** Server-only staged rollout. Keep unset until all reader and maintenance gates pass. */
export function createEnergyRepo(timezone:string,rawRepo?:EnergyRepo):EnergyRepo {
    if(!compactHistoryReadsEnabled())return rawRepo??new EnergyRepo();
    return new EnergyRepo(new CompactHistoryReader(new CompactHistoryStore(pool),timezone));
}
