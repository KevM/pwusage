import {afterEach,expect,it,vi} from 'vitest';
const {query,snapshot}=vi.hoisted(()=>({query:vi.fn<(...args:unknown[])=>Promise<{rows:Record<string,unknown>[]}>>(async()=>({rows:[]})),snapshot:vi.fn(async()=>({raw:[],days:[]}))}));
vi.mock('./db',()=>({pool:{query,connect:async()=>({query,release:vi.fn()})}}));
vi.mock('./prototypes/compact-history-store',()=>({CompactHistoryStore:class {readSnapshot=snapshot;}}));
import {createEnergyRepo} from './energy-repo-factory';
import {EnergyRepo} from './energy-repo';
afterEach(()=>{vi.unstubAllEnvs();query.mockClear();snapshot.mockClear();query.mockImplementation(async()=>({rows:[]}));});
it.each([undefined,'false','1','TRUE'])('keeps unpruned sites on raw reads unless the server switch is exactly true (%s)',async value=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED',value);
    await createEnergyRepo('UTC').getRawEnergyData('site',new Date(0),new Date(300000));
    expect(query.mock.calls.some(([sql])=>String(sql).includes('FROM "EnergyData"'))).toBe(true);expect(snapshot).not.toHaveBeenCalled();
});
it('opts unpruned sites into archive reads when explicitly enabled',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','true');
    await createEnergyRepo('UTC').getRawEnergyData('site',new Date(0),new Date(300000));
    expect(snapshot).toHaveBeenCalledOnce();expect(query).not.toHaveBeenCalled();
});
it('delegates to an injected raw repository for unpruned sites',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','false');const original=new EnergyRepo();
    const read=vi.spyOn(original,'getRawEnergyData').mockResolvedValue([]);
    await createEnergyRepo('UTC',original).getRawEnergyData('site',new Date(0),new Date(300000));
    expect(read).toHaveBeenCalledOnce();
});
it('keeps archive reads mandatory for a pruned site when the rollout flag is disabled',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','false');
    query.mockImplementation(async sql=>({rows:String(sql).includes('AS has_pruned')?[{has_pruned:true}]:[]}));
    await createEnergyRepo('UTC').getRawEnergyData('site',new Date(0),new Date(300000));
    expect(snapshot).toHaveBeenCalledOnce();
});
