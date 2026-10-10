import type {Pool} from 'pg';
import {pool} from './db';

/** Pruned history is a durable storage choice, independent of rollout switches. */
export async function hasPrunedHistory(siteIds:string[],database:Pick<Pool,'query'>=pool):Promise<boolean> {
    const result=await database.query<{has_pruned:boolean}>(`SELECT EXISTS (
        SELECT 1 FROM "EnergyDayArchive" WHERE site_id=ANY($1::text[]) AND raw_pruned
    ) AS has_pruned`,[siteIds]);
    return result.rows[0]?.has_pruned===true;
}
