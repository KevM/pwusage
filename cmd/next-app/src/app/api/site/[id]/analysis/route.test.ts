import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({access:vi.fn(),site:vi.fn(),raw:vi.fn(),client:vi.fn(),ensure:vi.fn(),audit:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:'token'})})}));
vi.mock('@/lib/site-service',()=>({SiteService:class {validateSiteAccess=mocks.access;}}));
vi.mock('@/lib/site-repo',()=>({SiteRepo:class {getSite=mocks.site;}}));
vi.mock('@/lib/energy-repo-factory',()=>({compactHistoryReadsEnabled:()=>true,createEnergyRepo:()=>({getRawEnergyData:mocks.raw})}));
vi.mock('@/lib/tesla-client-factory',()=>({createTeslaClientForSite:mocks.client}));
vi.mock('@/lib/importer',()=>({Importer:class {ensureDataForRange=mocks.ensure;auditRange=mocks.audit;}}));
vi.mock('@/lib/load-tag-repo',()=>({LoadTagRepo:class {async getLoadTags(){return [];}}}));
import {GET} from './route';
beforeEach(()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-07T15:00:00Z'));
    vi.clearAllMocks();mocks.access.mockResolvedValue(true);mocks.site.mockResolvedValue({id:'site',timezone:'America/Chicago',tariffs:[]});
    mocks.raw.mockResolvedValue([]);mocks.client.mockResolvedValue({});mocks.ensure.mockResolvedValue({complete:true});mocks.audit.mockResolvedValue([]);
});
afterEach(()=>vi.useRealTimers());
it.each(['2026-01-01','2026-10-08'])('reads %s without starting a Tesla recovery',async date=>{
    const response=await GET(new NextRequest('https://example.test/api/site/site/analysis?date='+date),{params:Promise.resolve({id:'site'})});
    expect(response.status).toBe(200);expect(mocks.raw).toHaveBeenCalledOnce();expect(mocks.client).not.toHaveBeenCalled();expect(mocks.ensure).not.toHaveBeenCalled();
});
it.each(['date=2026-10-07','date=2026-01-01&force=true'])('retains explicit/current sync (%s)',async query=>{
    const response=await GET(new NextRequest('https://example.test/api/site/site/analysis?'+query),{params:Promise.resolve({id:'site'})});
    expect(response.status).toBe(200);expect(mocks.client).toHaveBeenCalledOnce();expect(mocks.ensure).toHaveBeenCalledOnce();
});
it('rejects unauthorized access before history or Tesla reads',async()=>{
    mocks.access.mockResolvedValue(false);
    const response=await GET(new NextRequest('https://example.test/api/site/site/analysis?date=2026-01-01&force=true'),{params:Promise.resolve({id:'site'})});
    expect(response.status).toBe(403);expect(mocks.site).not.toHaveBeenCalled();expect(mocks.raw).not.toHaveBeenCalled();expect(mocks.client).not.toHaveBeenCalled();
});
