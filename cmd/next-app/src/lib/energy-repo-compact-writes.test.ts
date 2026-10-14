import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const {query,write}=vi.hoisted(()=>({query:vi.fn(),write:vi.fn()}));
vi.mock('./db',()=>({pool:{query,connect:async()=>({query,release:vi.fn()})}}));
vi.mock('./prototypes/compact-history-store',()=>({CompactHistoryStore:class {writeEnergyDataBatch=write;}}));
import {EnergyRepo} from './energy-repo';
const rows=[{site_id:'site',timestamp:new Date('2026-01-01T00:00:00Z'),tariff_id:1,tariff_schedule_id:2,load_power:10,solar_power:0,grid_power:10,battery_power:0,battery_soc:null}];
beforeEach(()=>{vi.clearAllMocks();write.mockResolvedValue(undefined);query.mockResolvedValue({rows:[],rowCount:1});});
afterEach(()=>vi.unstubAllEnvs());
it('uses atomic archive restoration for writes when compact history is enabled',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','true');
    await new EnergyRepo().insertEnergyDataBatch(rows);
    expect(write).toHaveBeenCalledExactlyOnceWith(rows);expect(query).not.toHaveBeenCalled();
});
it('preserves the original off-path write and conflict/SOC behavior',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','false');
    await new EnergyRepo().insertEnergyDataBatch(rows);
    expect(write).not.toHaveBeenCalled();
    const insert=query.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO'));
    expect(insert?.[0]).toContain('ON CONFLICT(timestamp, site_id)');
    expect(insert?.[0]).toContain('COALESCE(EXCLUDED.battery_soc');
});
it('does not fall back to a destructive partial write after recovery fails',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','true');write.mockRejectedValue(new Error('Recovery integrity mismatch'));
    await expect(new EnergyRepo().insertEnergyDataBatch(rows)).rejects.toThrow('Recovery integrity mismatch');
    expect(query).not.toHaveBeenCalled();
});
it('avoids any database work for empty input',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','true');await new EnergyRepo().insertEnergyDataBatch([]);
    expect(write).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
});
it('restores pruned history for corrections even after the read rollout flag is disabled',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','false');
    query.mockImplementation(async sql=>({rows:String(sql).includes('AS has_pruned')?[{has_pruned:true}]:[]}));
    await new EnergyRepo().insertEnergyDataBatch(rows);
    expect(write).toHaveBeenCalledExactlyOnceWith(rows);
    expect(query.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO'))).toBe(false);
});
