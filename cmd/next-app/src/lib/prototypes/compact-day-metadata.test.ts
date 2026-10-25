import { describe,expect,it } from 'vitest';
import { buildDayMetadata,buildDayMetadataV3,verifyDayMetadata } from './compact-day-metadata';
import type { DayAttribution } from './day-attribution';
import { toSample } from './compact-energy';
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

describe('metadata checksum v3 (samples x segments)',()=>{
    const samples=[0,300000,2700000,30000000].map(offset=>toSample(sample(offset)));
    const attribution:DayAttribution={timelineRevision:'current-tariff:1',segments:[{offset:0,tariffId:1,scheduleId:2},{offset:480,tariffId:1,scheduleId:3}]};
    it('rolls up through the segments and checksums the attribution',()=>{
        const meta=buildDayMetadataV3(samples,attribution,start,end);
        expect(meta).toMatchObject({checksumVersion:3,attributionComplete:true,sampleCount:4,attribution});
        expect(meta.summaries.map(s=>[s.tariff_schedule_id,s.sample_count])).toEqual([[2,3],[3,1]]);
        expect(()=>verifyDayMetadata(meta)).not.toThrow();
        for(const changed of [
            {...meta,attribution:{...attribution,timelineRevision:'current-tariff:9'}},
            {...meta,attribution:{...attribution,segments:[attribution.segments[0],{offset:485,tariffId:1,scheduleId:3}]}},
            {...meta,attribution:{...attribution,segments:[attribution.segments[0],{offset:480,tariffId:1,scheduleId:4}]}},
            {...meta,attribution:undefined},
            {...meta,checksumVersion:2 as const},
        ]) expect(()=>verifyDayMetadata(changed)).toThrow();
        const corrupted=structuredClone(meta);corrupted.summaries[0].load_power++;
        expect(()=>verifyDayMetadata(corrupted)).toThrow('Day metadata mismatch');
    });
    it('derives attribution_complete from the segments',()=>{
        const gap={...attribution,segments:[attribution.segments[0],{offset:480,tariffId:1,scheduleId:null}]};
        const meta=buildDayMetadataV3(samples,gap,start,end);
        expect(meta.attributionComplete).toBe(false);
        expect(()=>verifyDayMetadata(meta)).not.toThrow();
        expect(()=>verifyDayMetadata({...meta,attributionComplete:true})).toThrow('Day metadata mismatch');
    });
    it('keeps v2 digests verifying, and they never carry an attribution',()=>{
        const v2=buildDayMetadata([sample(0)],start,end,true);
        expect(v2.checksumVersion).toBe(2);
        expect(()=>verifyDayMetadata(v2)).not.toThrow();
        expect(()=>verifyDayMetadata({...v2,attribution})).toThrow('Day metadata mismatch');
        expect(()=>verifyDayMetadata({...v2,checksumVersion:1})).toThrow('Day metadata mismatch');
    });
});
