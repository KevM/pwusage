import { expect,it } from 'vitest';
import { buildDayMetadata,verifyDayMetadata } from './compact-day-metadata';
import type { EnergyData } from '../db-types';
const start=new Date('2026-10-01T05:00:00Z'); const end=new Date('2026-10-02T05:00:00Z');
const sample=(offset:number):EnergyData=>({site_id:'site',timestamp:new Date(+start+offset),tariff_id:1,tariff_schedule_id:2,
    load_power:20,solar_power:3,grid_power:5,battery_power:-2,battery_soc:null});
it('checksums daily totals and exact coverage including gaps',()=>{
    const meta=buildDayMetadata([sample(0),sample(300000),sample(2700000)],start,end,true);
    expect(meta).toMatchObject({sampleCount:3,first:start,last:new Date(+start+2700000),maxInteriorGapMs:2400000});
    expect(()=>verifyDayMetadata(meta)).not.toThrow();
    const corrupted=structuredClone(meta);corrupted.summaries[0].grid_power++;
    expect(()=>verifyDayMetadata(corrupted)).toThrow('Day metadata mismatch');
    expect(()=>verifyDayMetadata({...meta,attributionComplete:false})).toThrow('Day metadata mismatch');
    expect(()=>verifyDayMetadata({...meta,maxInteriorGapMs:0})).toThrow('Day metadata mismatch');
});
