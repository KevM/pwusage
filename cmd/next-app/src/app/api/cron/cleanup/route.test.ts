import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const {cleanup}=vi.hoisted(()=>({cleanup:vi.fn()}));
vi.mock('@/lib/prototypes/compact-history-store',()=>({CompactHistoryStore:class {cleanupLegacyHistory=cleanup;}}));
import {GET} from './route';
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('CRON_SECRET','fixture-secret');cleanup.mockResolvedValue({skipped:false,energyDeleted:1,tagsDeleted:2});});
afterEach(()=>vi.unstubAllEnvs());
const request=(authorized=true)=>new NextRequest('https://example.test/api/cron/cleanup',{headers:{authorization:authorized?'Bearer fixture-secret':'Bearer invalid'}});
it('preserves legacy cleanup while compact history is disabled',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','false');
    const response=await GET(request());expect(response.status).toBe(200);
    expect((await response.json()).deleted).toEqual({energyDeleted:1,tagsDeleted:2});
    expect(cleanup).toHaveBeenCalledOnce();expect(cleanup.mock.calls[0][0]).toBeInstanceOf(Date);
});
it('skips destructive cleanup in compact mode',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','true');
    const response=await GET(request());expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({success:true,skipped:true,reason:'compact-history-maintenance-required'});
    expect(cleanup).not.toHaveBeenCalled();
});
it('rejects unauthorized cleanup before any destructive action',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','true');
    expect((await GET(request(false))).status).toBe(401);
    expect(cleanup).not.toHaveBeenCalled();
});
it('does not resume deletion after rollback when archives exist or finalization is in progress',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','false');cleanup.mockResolvedValue({skipped:true});
    const response=await GET(request());expect(await response.json()).toMatchObject({skipped:true});
});
