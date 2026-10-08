import {expect,it} from 'vitest';
import {buildLatestMetadata,verifyLatestMetadata} from './compact-latest-metadata';
import type {EnergyData} from '../db-types';
const start=new Date('2026-01-01'),end=new Date('2026-01-02'),identity={siteId:'site',start,end,archiveChecksum:'a'.repeat(64)};
const row=(offset:number,soc:number|null):EnergyData=>({site_id:'site',timestamp:new Date(+start+offset),tariff_id:1,tariff_schedule_id:2,load_power:12,solar_power:3,grid_power:-4,battery_power:5,battery_soc:soc});
it('keeps distinct last sample and last known charge timestamps',()=>{
    const projection=buildLatestMetadata([row(0,0),row(300000,null)],identity);
    expect(projection.data.sample.timestamp).toBe(+start+300000);expect(projection.data.sample.batterySoc).toBeNull();
    expect(projection.data.soc).toEqual({timestamp:+start,value:0});
    expect(()=>verifyLatestMetadata(projection.data,projection.checksum,identity)).not.toThrow();
});
it('detects scalar tampering and identity/checksum substitutions',()=>{
    const projection=buildLatestMetadata([row(0,50)],identity);
    expect(()=>verifyLatestMetadata({...projection.data,sample:{...projection.data.sample,gridPower:999}},projection.checksum,identity)).toThrow('Latest metadata mismatch');
    expect(()=>verifyLatestMetadata(projection.data,projection.checksum,{...identity,siteId:'other'})).toThrow('Latest metadata mismatch');
    expect(()=>verifyLatestMetadata(projection.data,projection.checksum,{...identity,archiveChecksum:'b'.repeat(64)})).toThrow('Latest metadata mismatch');
});
it('keeps an all-null charge day unknown',()=>{
    expect(buildLatestMetadata([row(0,null)],identity).data.soc).toBeNull();
});
