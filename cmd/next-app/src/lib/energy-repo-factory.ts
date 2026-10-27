import {pool} from './db';
import {EnergyRepo} from './energy-repo';
import {CompactHistoryStore} from './prototypes/compact-history-store';
import {CompactHistoryReader} from './prototypes/compact-history-reader';

/** Energy history is read from day records (`EnergyDayArchive`), the only store. */
export function createEnergyRepo(timezone:string):EnergyRepo {
    return new EnergyRepo(new CompactHistoryReader(new CompactHistoryStore(pool),timezone));
}
