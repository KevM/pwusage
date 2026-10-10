import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool,PoolClient} from 'pg';
import {pool} from './db';
import {hasPrunedHistory} from './compact-history-policy';

const rawTransaction=new AsyncLocalStorage<PoolClient>();
/** Raw repository queries share the transaction that selected their storage backend. */
export function energyQueryExecutor():Pick<Pool,'query'> {return rawTransaction.getStore()??pool;}

export async function withRawEnergyAccess<T>(
    siteIds:string[],mode:'read'|'write',action:()=>Promise<T>,database:Pool=pool
):Promise<{kind:'raw';value:T}|{kind:'compact'}> {
    const client=await database.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='15s'");
        await client.query("SET LOCAL lock_timeout='3s'");
        // Trim/restore/import mutation claims use the same per-site key. Selection
        // and a raw operation cannot straddle the first prune. Sorted exclusive
        // writer locks avoid shared-to-exclusive upgrades in the mutation trigger.
        const lock=mode==='read'?'pg_advisory_xact_lock_shared':'pg_advisory_xact_lock';
        for(const site of [...new Set(siteIds)].sort()) {
            await client.query(`SELECT ${lock}(hashtextextended('compact-energy:' || $1::text,0))`,[site]);
        }
        if(await hasPrunedHistory(siteIds,client)) {await client.query('ROLLBACK');return {kind:'compact'};}
        const value=await rawTransaction.run(client,action);
        await client.query('COMMIT');return {kind:'raw',value};
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
}
