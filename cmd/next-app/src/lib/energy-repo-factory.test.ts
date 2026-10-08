import {afterEach,expect,it,vi} from 'vitest';
const {query,snapshot}=vi.hoisted(()=>({query:vi.fn(async()=>({rows:[]})),snapshot:vi.fn(async()=>({raw:[],days:[]}))}));
vi.mock('./db',()=>({pool:{query}}));
vi.mock('./prototypes/compact-history-store',()=>({CompactHistoryStore:class {readSnapshot=snapshot;}}));
import {createEnergyRepo} from './energy-repo-factory';
import {EnergyRepo} from './energy-repo';
afterEach(()=>{vi.unstubAllEnvs();query.mockClear();snapshot.mockClear();});
it.each([undefined,'false','1','TRUE'])('keeps raw reads unless the server switch is exactly true (%s)',async value=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED',value);
    await createEnergyRepo('UTC').getRawEnergyData('site',new Date(0),new Date(300000));
    expect(query).toHaveBeenCalledOnce();expect(snapshot).not.toHaveBeenCalled();
});
it('uses archive reads only when explicitly enabled',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','true');
    await createEnergyRepo('UTC').getRawEnergyData('site',new Date(0),new Date(300000));
    expect(snapshot).toHaveBeenCalledOnce();expect(query).not.toHaveBeenCalled();
});
it('preserves an injected raw repository while the switch is off',()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','false');const original=new EnergyRepo();
    expect(createEnergyRepo('UTC',original)).toBe(original);
});
