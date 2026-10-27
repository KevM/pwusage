import {afterEach,expect,it,vi} from 'vitest';
const {query,snapshot}=vi.hoisted(()=>({query:vi.fn<(...args:unknown[])=>Promise<{rows:Record<string,unknown>[]}>>(async()=>({rows:[]})),snapshot:vi.fn(async()=>({raw:[],days:[]}))}));
vi.mock('./db',()=>({pool:{query,connect:async()=>({query,release:vi.fn()})}}));
vi.mock('./prototypes/compact-history-store',()=>({CompactHistoryStore:class {readSnapshot=snapshot;}}));
import {createEnergyRepo} from './energy-repo-factory';
afterEach(()=>{query.mockClear();snapshot.mockClear();});
it('reads energy history from day records',async()=>{
    await createEnergyRepo('UTC').getRawEnergyData('site',new Date(0),new Date(300000));
    expect(snapshot).toHaveBeenCalledOnce();expect(query).not.toHaveBeenCalled();
});
