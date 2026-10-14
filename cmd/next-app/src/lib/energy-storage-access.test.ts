import {expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {energyQueryExecutor,withRawEnergyAccess} from './energy-storage-access';
function fixture(pruned=false) {
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('AS has_pruned')?[{has_pruned:pruned}]:[]}));
    const client={query,release:vi.fn()} as unknown as PoolClient;
    const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
    return {query,client,pool};
}
it('holds a site lock and uses the same transaction for selection and raw reads',async()=>{
    const {query,client,pool}=fixture();
    expect(await withRawEnergyAccess(['site'],'read',async()=>{
        expect(energyQueryExecutor()).toBe(client);
        await energyQueryExecutor().query('SELECT raw history');return 'raw';
    },pool)).toEqual({kind:'raw',value:'raw'});
    const statements=query.mock.calls.map(([sql])=>sql);
    expect(statements.findIndex(sql=>sql.includes('pg_advisory_xact_lock_shared'))).toBeLessThan(statements.findIndex(sql=>sql.includes('AS has_pruned')));
    expect(statements.at(-1)).toBe('COMMIT');
});
it('releases the selection transaction before requiring archive access',async()=>{
    const {query,pool}=fixture(true);const raw=vi.fn();
    expect(await withRawEnergyAccess(['site'],'read',raw,pool)).toEqual({kind:'compact'});
    expect(raw).not.toHaveBeenCalled();expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
});
it('takes exclusive sorted site locks for a raw write and rolls back failures',async()=>{
    const {query,client,pool}=fixture();
    await expect(withRawEnergyAccess(['z','a'],'write',async()=>{throw new Error('write failed');},pool)).rejects.toThrow('write failed');
    const locks=query.mock.calls.filter(([sql])=>sql.includes('pg_advisory_xact_lock('));
    expect(locks).toHaveLength(2);expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(client.release).toHaveBeenCalledOnce();
});
