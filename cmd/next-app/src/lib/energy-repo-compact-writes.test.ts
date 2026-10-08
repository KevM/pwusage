import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const {query,write}=vi.hoisted(()=>({query:vi.fn(),write:vi.fn()}));
vi.mock('./db',()=>({pool:{query}}));
vi.mock('./prototypes/compact-history-store',()=>({CompactHistoryStore:class {writeEnergyDataBatch=write;}}));
import {EnergyRepo} from './energy-repo';
const rows=[{site_id:'site',timestamp:new Date('2026-01-01T00:00:00Z'),tariff_id:1,tariff_schedule_id:2,load_power:10,solar_power:0,grid_power:10,battery_power:0,battery_soc:null}];
beforeEach(()=>{vi.clearAllMocks();write.mockResolvedValue(undefined);query.mockResolvedValue({rowCount:1});});
afterEach(()=>vi.unstubAllEnvs());
it('uses atomic archive restoration for writes when compact history is enabled',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','true');
    await new EnergyRepo().insertEnergyDataBatch(rows);
    expect(write).toHaveBeenCalledExactlyOnceWith(rows);expect(query).not.toHaveBeenCalled();
});
it('preserves the original off-path write and conflict/SOC behavior',async()=>{
    vi.stubEnv('COMPACT_HISTORY_READS_ENABLED','false');
    await new EnergyRepo().insertEnergyDataBatch(rows);
    expect(write).not.toHaveBeenCalled();expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT(timestamp, site_id)');
    expect(query.mock.calls[0][0]).toContain('COALESCE(EXCLUDED.battery_soc');
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
