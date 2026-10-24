import {afterEach,expect,it,vi} from 'vitest';
import {runHistoryArchive,readArchiveOptions,ArchiveControlChangedError,type ArchiveJobRepo,type ArchiveCandidate} from './history-archive-service';
const now=new Date('2026-10-07T20:00:00Z');
const day:ArchiveCandidate={siteId:'site',start:new Date('2025-01-01T06:00:00Z'),end:new Date('2025-01-02T06:00:00Z'),timezone:'America/Chicago',trim:true};
afterEach(()=>vi.restoreAllMocks());
function fixture() {
    const repo:ArchiveJobRepo={claim:vi.fn(async()=>true),release:vi.fn(async()=>{}),control:vi.fn(async()=>({paused:false,trim:false,revision:"1"})),
        next:vi.fn(async()=>day),estimate:vi.fn(async()=>100000),finalize:vi.fn<ArchiveJobRepo['finalize']>(async()=>({status:'finalized',revision:'revision',attributionComplete:true})),
        trim:vi.fn<ArchiveJobRepo['trim']>(async()=>({status:'trimmed',samples:288})),retry:vi.fn(async()=>{}),clearRetry:vi.fn(async()=>{}),saveReport:vi.fn(async()=>{})};
    const options={now,retentionDays:365,archiveAfterDays:2,maxDays:1,maxTimeMs:30000,maxEstimatedBytes:1000000,readsEnabled:true};return {repo,options};
}
it('does nothing while paused and releases its claim',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.control).mockResolvedValue({paused:true,trim:true,revision:"2"});
    expect((await runHistoryArchive(repo,options)).stopped).toBe('paused');expect(repo.next).not.toHaveBeenCalled();expect(repo.release).toHaveBeenCalledOnce();
});
it('retains raw rows in archive-only mode and reports durable progress',async()=>{
    const {repo,options}=fixture();const result=await runHistoryArchive(repo,options);
    expect(result.days[0].status).toBe('archived');expect(repo.trim).not.toHaveBeenCalled();expect(repo.saveReport).toHaveBeenCalledWith(result);
});
it('requires compact readers before doing trim-mode work',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.control).mockResolvedValue({paused:false,trim:true,revision:"1"});
    expect((await runHistoryArchive(repo,{...options,readsEnabled:false})).stopped).toBe('readers-disabled');expect(repo.finalize).not.toHaveBeenCalled();
});
it('passes the verified revision to trimming',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.control).mockResolvedValue({paused:false,trim:true,revision:"1"});
    expect((await runHistoryArchive(repo,options)).days[0]).toMatchObject({status:'trimmed',samples:288});expect(repo.trim).toHaveBeenCalledWith(day,'revision',now,{paused:false,trim:true,revision:'1'});
});
it('keeps incomplete attribution recoverable and backs off the day',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.control).mockResolvedValue({paused:false,trim:true,revision:"1"});
    vi.mocked(repo.finalize).mockResolvedValue({status:'finalized',revision:'revision',attributionComplete:false});
    expect((await runHistoryArchive(repo,options)).days[0].status).toBe('incomplete-attribution');expect(repo.trim).not.toHaveBeenCalled();expect(repo.retry).toHaveBeenCalledWith(day,'incomplete-attribution',now);
});
it('rechecks pause after finalization before trimming',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.control).mockResolvedValueOnce({paused:false,trim:true,revision:"1"}).mockResolvedValueOnce({paused:false,trim:true,revision:"1"}).mockResolvedValueOnce({paused:true,trim:true,revision:"2"});
    expect((await runHistoryArchive(repo,options)).stopped).toBe('paused');expect(repo.trim).not.toHaveBeenCalled();
});
it('refuses a day ending inside the archive-after window',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.next).mockResolvedValue({...day,start:new Date('2026-10-06T05:00:00Z'),end:new Date('2026-10-07T05:00:00Z')});
    expect((await runHistoryArchive(repo,options)).days[0].status).toBe('failed');expect(repo.finalize).not.toHaveBeenCalled();
});
it('archives a day inside retention once it is past the archive-after window',async()=>{
    const {repo,options}=fixture();const recent={...day,start:new Date('2026-10-04T05:00:00Z'),end:new Date('2026-10-05T05:00:00Z'),trim:false};
    vi.mocked(repo.next).mockResolvedValue(recent);
    expect((await runHistoryArchive(repo,options)).days[0].status).toBe('archived');expect(repo.finalize).toHaveBeenCalledWith(recent,now,{paused:false,trim:false,revision:'1'});
});
it('in trim mode archives without trimming a day the repo did not mark for trim',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.control).mockResolvedValue({paused:false,trim:true,revision:"1"});
    vi.mocked(repo.next).mockResolvedValue({...day,trim:false});
    expect((await runHistoryArchive(repo,options)).days[0].status).toBe('archived');expect(repo.trim).not.toHaveBeenCalled();
});
it('never trims a marked day that ends inside retention',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.control).mockResolvedValue({paused:false,trim:true,revision:"1"});
    vi.mocked(repo.next).mockResolvedValue({...day,start:new Date('2026-10-04T05:00:00Z'),end:new Date('2026-10-05T05:00:00Z'),trim:true});
    expect((await runHistoryArchive(repo,options)).days[0].status).toBe('archived');expect(repo.trim).not.toHaveBeenCalled();
});
it('asks the repo for days past the archive-after window with the trim retention',async()=>{
    const {repo,options}=fixture();await runHistoryArchive(repo,{...options,retentionDays:90,archiveAfterDays:3});
    expect(repo.next).toHaveBeenCalledWith(90,3,now,false);
});
it('reserves transfer estimates before fetching source rows',async()=>{
    const {repo,options}=fixture();const report=await runHistoryArchive(repo,{...options,maxEstimatedBytes:40000});
    expect(report.stopped).toBe('byte-budget');expect(repo.finalize).not.toHaveBeenCalled();expect(report.estimatedBytes).toBeLessThanOrEqual(40000);
});
it('stops on time budget before discovering another day',async()=>{
    const {repo,options}=fixture();let calls=0;const clock=()=>calls++===0?0:30001;
    expect((await runHistoryArchive(repo,options,clock)).stopped).toBe('time-budget');expect(repo.next).not.toHaveBeenCalled();
});
it('persists safe failure codes and releases the run claim',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.finalize).mockRejectedValue(new Error('secret SQL connection information'));
    const report=await runHistoryArchive(repo,options);expect(report.days[0].status).toBe('failed');expect(JSON.stringify(report)).not.toContain('secret');expect(repo.retry).toHaveBeenCalledWith(day,'failed',now);expect(repo.release).toHaveBeenCalledOnce();
});
it('does not release a claim it never acquired',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.claim).mockResolvedValue(false);expect((await runHistoryArchive(repo,options)).stopped).toBe('busy');expect(repo.release).not.toHaveBeenCalled();
});
it('fails closed on malformed environment options',()=>{
    for(const value of ['0','-1','365days','NaN',''])expect(()=>readArchiveOptions({NODE_ENV:'test',DATA_RETENTION_DAYS:value})).toThrow();expect(readArchiveOptions({NODE_ENV:'test'}).retentionDays).toBe(365);
});
it('archives after 2 days by default, separately from trim retention',()=>{
    expect(readArchiveOptions({NODE_ENV:'test'}).archiveAfterDays).toBe(2);
    expect(readArchiveOptions({NODE_ENV:'test',HISTORY_ARCHIVE_AFTER_DAYS:'7',DATA_RETENTION_DAYS:'90'})).toMatchObject({archiveAfterDays:7,retentionDays:90});
    for(const value of ['0','1','-1','2days',''])expect(()=>readArchiveOptions({NODE_ENV:'test',HISTORY_ARCHIVE_AFTER_DAYS:value})).toThrow();
});
it('leaves room for an admitted transaction and reporting within the 60-second deployment limit',()=>{
    expect(readArchiveOptions({NODE_ENV:'test'}).maxTimeMs).toBe(30000);
    expect(()=>readArchiveOptions({NODE_ENV:'test',HISTORY_ARCHIVE_MAX_TIME_MS:'30001'})).toThrow();
});
it('checks the deadline after discovery and preflight before finalizing',async()=>{
    const {repo,options}=fixture();let elapsed=0;vi.mocked(repo.estimate).mockImplementation(async()=>{elapsed=30001;return 100000;});
    expect((await runHistoryArchive(repo,options,()=>elapsed)).stopped).toBe('time-budget');expect(repo.finalize).not.toHaveBeenCalled();
});
it('changing to archive-only between phases prevents trim',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.control).mockResolvedValueOnce({paused:false,trim:true,revision:"1"}).mockResolvedValueOnce({paused:false,trim:true,revision:"1"}).mockResolvedValueOnce({paused:false,trim:false,revision:"1"});
    expect((await runHistoryArchive(repo,options)).stopped).toBe('mode-changed');expect(repo.trim).not.toHaveBeenCalled();
});
it('stops after recording an oversized day without discovering another day',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.estimate).mockResolvedValueOnce(options.maxEstimatedBytes).mockResolvedValue(100000);
    const report=await runHistoryArchive(repo,{...options,maxDays:2});
    expect(report.stopped).toBe('byte-budget');expect(report.days).toHaveLength(1);
    expect(report.days[0].status).toBe('source-too-large');expect(repo.next).toHaveBeenCalledOnce();
    expect(repo.finalize).not.toHaveBeenCalled();expect(repo.retry).toHaveBeenCalledWith(day,'source-too-large',now);
    expect(repo.saveReport).toHaveBeenCalledWith(report);
});
it('returns completed progress when releasing the claim fails without exposing database details',async()=>{
    const {repo,options}=fixture();vi.mocked(repo.release).mockRejectedValue(new Error('private database details'));
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const report=await runHistoryArchive(repo,options);
    expect(report.days[0].status).toBe('archived');expect(repo.saveReport).toHaveBeenCalledWith(report);
    expect(warning).toHaveBeenCalledOnce();expect(JSON.stringify(warning.mock.calls)).not.toContain('private');
});
it('preserves a progress-write failure when releasing the claim also fails',async()=>{
    const {repo,options}=fixture();const failure=new Error('progress write failed');
    vi.mocked(repo.saveReport).mockRejectedValue(failure);vi.mocked(repo.release).mockRejectedValue(new Error('release failed'));
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    await expect(runHistoryArchive(repo,options)).rejects.toBe(failure);
    expect(repo.release).toHaveBeenCalledOnce();
});

it.each(['before archive','before trim'])('stops a replaced cohort %s even when trim mode stays enabled',async phase=>{
    const {repo,options}=fixture();
    vi.mocked(repo.control).mockResolvedValue({paused:false,trim:true,revision:'2'});
    vi.mocked(repo.control).mockResolvedValueOnce({paused:false,trim:true,revision:'1'});
    if(phase==='before trim')vi.mocked(repo.control).mockResolvedValueOnce({paused:false,trim:true,revision:'1'});
    expect((await runHistoryArchive(repo,options)).stopped).toBe('control-changed');
    expect(repo.trim).not.toHaveBeenCalled();
    if(phase==='before archive')expect(repo.finalize).not.toHaveBeenCalled();
});

it('reports a committed archive when the transactional trim guard observes a control edit',async()=>{
    const {repo,options}=fixture();
    vi.mocked(repo.control).mockResolvedValue({paused:false,trim:true,revision:'1'});
    vi.mocked(repo.trim).mockRejectedValueOnce(new ArchiveControlChangedError());
    const report=await runHistoryArchive(repo,options);
    expect(report).toMatchObject({stopped:'control-changed',days:[{siteId:day.siteId,status:'archived'}]});
    expect(repo.retry).not.toHaveBeenCalled();
});
