import {afterEach,expect,it,vi} from 'vitest';
import {Importer} from './importer';
import type {TeslaClient} from './tesla-client';
const {coverage,rawQuery}=vi.hoisted(()=>({coverage:vi.fn(),rawQuery:vi.fn<(...args:unknown[])=>Promise<{rows:Record<string,unknown>[]}>>(async()=>{throw new Error('Unexpected direct query');})}));
vi.mock('./db',()=>({pool:{query:rawQuery,connect:async()=>({query:rawQuery,release:vi.fn()})}}));
vi.mock('./site-repo',()=>({SiteRepo:class {async getSite(){return {id:'site',timezone:'UTC',installed:new Date('2026-01-01'),tariffs:[]};}}}));
vi.mock('./import-lock',()=>({withImportLock:async<T>(_repo:unknown,_options:unknown,callback:()=>Promise<T>)=>({status:'acquired',value:await callback()})}));
vi.mock('./prototypes/compact-history-store',()=>({CompactHistoryStore:class {readScalarSnapshot=coverage;async readSnapshot(){throw new Error('Unexpected chart payload');}}}));
afterEach(()=>{vi.restoreAllMocks();coverage.mockClear();rawQuery.mockClear();});
it('recognizes complete archived coverage without planning a paid Tesla backfill',async()=>{
    const start=new Date('2026-01-01'),end=new Date('2026-01-02');
    coverage.mockResolvedValue({timezone:'UTC',aggregates:[],coverage:[{localDayKey:'2026-01-01',count:288,first:start,last:new Date(+end-300000),maxInteriorGapMs:300000}],detail:{raw:[],days:[]}});
    const importer=new Importer({} as TeslaClient);
    const importDays=vi.spyOn(importer as unknown as {importDayRecords:()=>Promise<unknown>},'importDayRecords').mockRejectedValue(new Error('Unexpected paid request'));
    expect(await importer.ensureDataForRange('site',start,end)).toEqual({complete:true,rows:[],processedWindows:0,totalWindows:0});
    expect(importDays).not.toHaveBeenCalled();expect(rawQuery).not.toHaveBeenCalled();
    const audit=await importer.auditRange('site',start,end);
    expect(audit).toMatchObject([{count:288}]);
    expect(coverage).toHaveBeenCalledTimes(2);
});

it('fails closed on archive corruption before making any import request',async()=>{
    coverage.mockRejectedValue(new Error('Day metadata mismatch'));
    const importer=new Importer({} as TeslaClient);
    const importDays=vi.spyOn(importer as unknown as {importDayRecords:()=>Promise<unknown>},'importDayRecords').mockRejectedValue(new Error('Unexpected paid request'));
    await expect(importer.ensureDataForRange('site',new Date('2026-01-01'),new Date('2026-01-02'))).rejects.toThrow('Day metadata mismatch');
    expect(importDays).not.toHaveBeenCalled();expect(rawQuery).not.toHaveBeenCalled();
});
