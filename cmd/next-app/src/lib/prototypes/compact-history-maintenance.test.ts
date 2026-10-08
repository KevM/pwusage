import {describe,expect,it,vi} from 'vitest';
import {runCompactMaintenance,parseMaintenanceArgs,type MaintenanceSnapshot,type MaintenanceStore} from './compact-history-maintenance';
const start=new Date('2026-01-01T06:00:00Z');
const end=new Date('2026-01-04T06:00:00Z');
const now=new Date('2026-01-07T12:00:00Z');
const snapshot=():MaintenanceSnapshot=>({timezone:'America/Chicago',start,end,coverage:[
    {localDayKey:'2026-01-01',count:288,first:start,last:new Date(+start+86100000),maxInteriorGapMs:300000},
    {localDayKey:'2026-01-02',count:2,first:new Date(+start+86400000),last:new Date(+start+86700000),maxInteriorGapMs:300000}
],archives:[]});
const input={siteId:'site',from:'2026-01-01',before:'2026-01-04',now};
const fixture=()=>({getMaintenanceSnapshot:vi.fn(async()=>snapshot()),finalizeDay:vi.fn<MaintenanceStore['finalizeDay']>(async()=>({status:'finalized'}))});
describe('bounded raw-retaining maintenance',()=>{
    it('previews all days and gaps without finalizing or creating empty archives',async()=>{
        const store=fixture();const report=await runCompactMaintenance(store,input);
        expect(store.finalizeDay).not.toHaveBeenCalled();expect(report.mode).toBe('preview');
        expect(report.days.map(d=>({date:d.date,status:d.status,repair:d.needsRepair}))).toEqual([
            {date:'2026-01-01',status:'pending',repair:false},{date:'2026-01-02',status:'pending',repair:true},{date:'2026-01-03',status:'empty',repair:true}
        ]);expect(report.remaining).toEqual(['2026-01-01','2026-01-02']);
    });
    it('applies only a bounded chunk and reports a continuation',async()=>{
        const store=fixture();const report=await runCompactMaintenance(store,{...input,apply:true,maxDays:1});
        expect(store.finalizeDay).toHaveBeenCalledExactlyOnceWith('site',start,now);
        expect(report.remaining).toEqual(['2026-01-02']);expect(report.days[0].status).toBe('finalized');
    });
    it('reuses verified archives by default and rebuilds only when explicitly requested',async()=>{
        const store=fixture();store.getMaintenanceSnapshot.mockResolvedValue({...snapshot(),archives:[{start,attributionComplete:true}]});
        const report=await runCompactMaintenance(store,{...input,apply:true});
        expect(report.days[0].status).toBe('archived');expect(store.finalizeDay).toHaveBeenCalledTimes(1);
        store.finalizeDay.mockClear();await runCompactMaintenance(store,{...input,apply:true,rebuild:true});
        expect(store.finalizeDay).toHaveBeenCalledTimes(2);
    });
    it('reports the resulting incomplete tariff attribution after apply',async()=>{
        const store=fixture();store.finalizeDay.mockResolvedValue({status:'finalized',attributionComplete:false});
        const report=await runCompactMaintenance(store,{...input,apply:true});
        expect(report.days[0].attributionComplete).toBe(false);expect(report.days[0].needsRepair).toBe(true);
    });
    it('stops on a busy claim without skipping that date',async()=>{
        const store=fixture();store.finalizeDay.mockResolvedValue({status:'busy'});
        const report=await runCompactMaintenance(store,{...input,apply:true});
        expect(store.finalizeDay).toHaveBeenCalledTimes(1);expect(report.remaining).toEqual(['2026-01-01','2026-01-02']);
        expect(report.stopped).toBe('busy');
    });
    it('honors elapsed budget before starting more finalization work',async()=>{
        const store=fixture();let ticks=0;
        const report=await runCompactMaintenance(store,{...input,apply:true,maxTimeMs:1000},()=>ticks++*1000);
        expect(store.finalizeDay).not.toHaveBeenCalled();expect(report.stopped).toBe('time-budget');
    });
    it('propagates integrity/finalization failures without a success report',async()=>{
        const store=fixture();store.finalizeDay.mockRejectedValue(new Error('Integrity mismatch'));
        await expect(runCompactMaintenance(store,{...input,apply:true})).rejects.toThrow('Integrity mismatch');
    });
    it.each([0,8,1.5,NaN])('rejects invalid day budgets before reading %s',async maxDays=>{
        const store=fixture();await expect(runCompactMaintenance(store,{...input,maxDays})).rejects.toThrow('budget');
        expect(store.getMaintenanceSnapshot).not.toHaveBeenCalled();
    });
});
describe('maintenance CLI arguments',()=>{
    const args=['--site-id','site','--from','2026-01-01','--before','2026-01-04'];
    it('defaults to preview and requires explicit apply/rebuild',()=>{
        expect(parseMaintenanceArgs(args)).toMatchObject({siteId:'site',from:'2026-01-01',before:'2026-01-04',apply:false,rebuild:false,maxDays:7});
        expect(parseMaintenanceArgs([...args,'--apply','--rebuild','--max-days','2'])).toMatchObject({apply:true,rebuild:true,maxDays:2});
    });
    it.each([[],[...args,'--trim'],[...args,'--site-id','again'],[...args,'--max-days','99'],[...args,'--max-days','1x'],['--site-id','site','--from','2026-02-30','--before','2026-03-01']].map(invalid=>[invalid] as const))('rejects unsafe or ambiguous inputs %j',invalid=>{
        expect(()=>parseMaintenanceArgs(invalid)).toThrow();
    });
});
