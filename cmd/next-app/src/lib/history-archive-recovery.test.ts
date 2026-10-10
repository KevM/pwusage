import {expect,it,vi} from 'vitest';
import {parseRestorePlan,restoreHistoryPlan,type HistoryRecoveryRepo} from './history-archive-recovery';
const day={siteId:'site',start:'2026-01-01T06:00:00.000Z',revision:'12345678-1234-1234-1234-123456789012'};
function fixture() {
    const repo:HistoryRecoveryRepo={restore:vi.fn<HistoryRecoveryRepo['restore']>(async()=>({status:'restored',samples:288})),remaining:vi.fn(async()=>0)};
    return repo;
}
it('rejects malformed, duplicate and unbounded recovery plans before mutation',()=>{
    for(const input of [null,{version:1,days:[]},{version:1,days:Array(8).fill(day)},{version:1,days:[day,day]},
        {version:1,days:[{...day,start:'2026-01-01'}]},{version:1,days:[{...day,revision:''}]}]) {
        expect(()=>parseRestorePlan(input)).toThrow();
    }
});
it('uses the explicitly reviewed revision for every restored day and reports rollback readiness',async()=>{
    const repo=fixture();const plan=parseRestorePlan({version:1,days:[day]});
    expect(await restoreHistoryPlan(repo,plan)).toMatchObject({days:[{...day,status:'restored',samples:288}],remainingPrunedDays:0,stopped:'complete'});
    expect(repo.restore).toHaveBeenCalledExactlyOnceWith(day);
});
it('stops admitting work after its budget without discarding unprocessed plan entries',async()=>{
    const repo=fixture();let elapsed=0;vi.mocked(repo.restore).mockImplementation(async()=>{elapsed=30000;return {status:'restored',samples:288};});
    const second={...day,start:'2026-01-02T06:00:00.000Z'};vi.mocked(repo.remaining).mockResolvedValue(1);
    const report=await restoreHistoryPlan(repo,parseRestorePlan({version:1,days:[day,second]}),()=>elapsed);
    expect(report.stopped).toBe('time-budget');expect(report.days).toHaveLength(1);expect(report.remainingPrunedDays).toBe(1);
});
it('preserves integrity errors and never continues after failed recovery',async()=>{
    const repo=fixture();vi.mocked(repo.restore).mockRejectedValue(new Error('Recovery integrity mismatch'));
    await expect(restoreHistoryPlan(repo,parseRestorePlan({version:1,days:[day]}))).rejects.toThrow('Recovery integrity mismatch');
});
