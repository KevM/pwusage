import {expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {HistoryArchiveRepo} from './history-archive-repo';
it('pins the job claim to a transaction for Supabase transaction pooling',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:[{acquired:sql.length>0}]}));const release=vi.fn();
    const client={query,release,on:vi.fn(),off:vi.fn()} as unknown as PoolClient;
    const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
    const repo=new HistoryArchiveRepo(pool);expect(await repo.claim()).toBe(true);await repo.release();
    expect(query.mock.calls[0][0]).toBe('BEGIN');
    expect(query.mock.calls.some(([sql])=>String(sql).includes('pg_try_advisory_xact_lock'))).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(release).toHaveBeenCalledOnce();
});
it('disables JIT inside the claim so unanalyzed tiny tables cannot stall next() past its timeout',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:[{acquired:sql.length>0}]}));
    const client={query,release:vi.fn(),on:vi.fn(),off:vi.fn()} as unknown as PoolClient;
    const repo=new HistoryArchiveRepo({connect:vi.fn(async()=>client)} as unknown as Pool);
    await repo.claim();await repo.release();
    const sql=query.mock.calls.map(([text])=>String(text));
    const jit=sql.indexOf("SET LOCAL jit=off");
    expect(jit).toBeGreaterThan(sql.indexOf('BEGIN'));
    expect(jit).toBeLessThan(sql.findIndex(text=>text.includes('pg_try_advisory_xact_lock')));
});
