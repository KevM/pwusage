import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const {run}=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('@/lib/history-archive-service',async importOriginal=>({...await importOriginal<typeof import('@/lib/history-archive-service')>(),runHistoryArchive:run}));
vi.mock('@/lib/history-archive-repo',()=>({HistoryArchiveRepo:class {}}));
import {GET} from './route';
const request=(authorized=true)=>new NextRequest('https://example.test/api/cron/cleanup',{headers:{authorization:authorized?'Bearer fixture-secret':'Bearer invalid'}});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('CRON_SECRET','fixture-secret');vi.stubEnv('HISTORY_ARCHIVE_JOB_ENABLED','false');run.mockResolvedValue({days:[],stopped:'paused',estimatedBytes:0,teslaRequests:0});});
afterEach(()=>vi.unstubAllEnvs());
it('pauses retention by default without invoking legacy deletion',async()=>{
    const response=await GET(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({success:true,skipped:true,reason:'archive-job-disabled'});expect(run).not.toHaveBeenCalled();
});
it('runs bounded archival when explicitly enabled',async()=>{
    vi.stubEnv('HISTORY_ARCHIVE_JOB_ENABLED','true');const response=await GET(request());expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({success:true,archive:{stopped:'paused'}});expect(run).toHaveBeenCalledOnce();
});
it('rejects unauthorized cron calls before maintenance',async()=>{
    vi.stubEnv('HISTORY_ARCHIVE_JOB_ENABLED','true');expect((await GET(request(false))).status).toBe(401);expect(run).not.toHaveBeenCalled();
});
it('rejects missing secrets and malformed retention before maintenance',async()=>{
    vi.stubEnv('CRON_SECRET','');expect((await GET(request())).status).toBe(401);
    vi.stubEnv('CRON_SECRET','fixture-secret');vi.stubEnv('HISTORY_ARCHIVE_JOB_ENABLED','true');vi.stubEnv('DATA_RETENTION_DAYS','365days');
    expect((await GET(request())).status).toBe(500);expect(run).not.toHaveBeenCalled();
});
it('does not expose operational database errors',async()=>{
    vi.stubEnv('HISTORY_ARCHIVE_JOB_ENABLED','true');run.mockRejectedValue(new Error('private SQL data'));
    const response=await GET(request());expect(response.status).toBe(500);expect(JSON.stringify(await response.json())).not.toContain('private');
});
