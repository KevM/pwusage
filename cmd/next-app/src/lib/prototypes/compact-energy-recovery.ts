/** Integrity required before restoring or discarding the raw recovery source. */
import {deepStrictEqual} from 'node:assert';
import {createHash} from 'node:crypto';
import type {EnergyData} from '../db-types';
import {decodeDay,decodeDaySamples,rollupDay,type ArchiveCodec,type DayRollup} from './compact-energy';
import {buildDayMetadata,buildDayMetadataV3} from './compact-day-metadata';
import {attributeSamples,type DayAttribution} from './day-attribution';
import {buildLatestMetadata,verifyLatestMetadata,type LatestMetadata} from './compact-latest-metadata';
export interface RecoveryArchive {
    site_id:string;day_start:Date;day_end:Date;revision:string;format_version:number;codec:ArchiveCodec;axis:'grid'|'offsets';checksum:string;payload:Buffer;
    expected_slots:number;sample_count:number;attribution_complete:boolean;first_timestamp:Date|null;last_timestamp:Date|null;max_interior_gap_ms:number|null;
    metadata_checksum:string|null;metadata_version:1|2|3;latest_metadata:LatestMetadata|null;latest_checksum:string|null;payload_checksum:string|null;raw_pruned:boolean;
    /** Format 2 (metadata 3) only. */
    attribution:DayAttribution|null;status:'open'|'complete'|'gapped'|null;fetched_at:Date|null;
}
export function equalRecoveryValue(left:unknown,right:unknown):boolean {
    try {deepStrictEqual(left,right);return true;}catch {return false;}
}
export function recoverVerifiedSamples(a:RecoveryArchive,summaries:DayRollup[]):EnergyData[] {
    const v2=a.format_version===2&&a.metadata_version===3&&!!a.attribution;
    if(!(v2||(a.format_version===1&&a.metadata_version===2))||!a.payload_checksum||!a.latest_metadata||!a.latest_checksum
        ||createHash('sha256').update(a.payload).digest('hex')!==a.payload_checksum)throw new Error('Recovery archive integrity mismatch');
    const start=new Date(a.day_start),end=new Date(a.day_end);
    const archive={codec:a.codec,axis:a.axis,sha256:a.checksum,data:a.payload,expectedSlots:a.expected_slots},id={siteId:a.site_id,start,end};
    // Format 2 rows take their tariff IDs from the segment covering each label.
    const samples=v2?decodeDaySamples(archive,id):[];
    const rows=v2?attributeSamples(samples,a.attribution!,start,end):decodeDay(archive,id);
    const metadata=v2?buildDayMetadataV3(samples,a.attribution!,start,end):buildDayMetadata(rows,start,end,a.attribution_complete);
    if(metadata.attributionComplete!==a.attribution_complete)throw new Error('Recovery summary integrity mismatch');
    const sort=(values:DayRollup[])=>[...values].sort((x,y)=>x.tariff_id-y.tariff_id||(x.tariff_schedule_id??-1)-(y.tariff_schedule_id??-1));
    if(a.metadata_checksum!==metadata.checksum||a.sample_count!==metadata.sampleCount||a.expected_slots!== (+end-+start)/300000
        ||+(a.first_timestamp??NaN)!==+metadata.first||+(a.last_timestamp??NaN)!==+metadata.last||a.max_interior_gap_ms!==metadata.maxInteriorGapMs
        ||!equalRecoveryValue(sort(summaries),sort(rollupDay(rows,start))))throw new Error('Recovery summary integrity mismatch');
    const identity={siteId:a.site_id,start,end,archiveChecksum:a.checksum};
    verifyLatestMetadata(a.latest_metadata,a.latest_checksum,identity);
    const expected=buildLatestMetadata(rows,identity);
    if(expected.checksum!==a.latest_checksum||!equalRecoveryValue(JSON.parse(JSON.stringify(expected.data)) as LatestMetadata,a.latest_metadata))throw new Error('Recovery latest projection mismatch');
    return rows;
}
export interface EnergyWrite {
    site_id:string;timestamp:Date;tariff_id:number;tariff_schedule_id?:number|null;
    load_power:number;solar_power:number;grid_power:number;battery_power:number;battery_soc:number|null;
}

/** Canonical binary digest shared with PostgreSQL; preserves Float64 signed zero. */
export function rawDayDigest(rows:EnergyData[],siteId:string,start:Date,end:Date):string {
    const site=Buffer.from(siteId,'utf8');
    const header=Buffer.alloc(5+4+site.length+8+8+4);let offset=0;
    header.write('CERS1',offset);offset+=5;header.writeInt32BE(site.length,offset);offset+=4;
    site.copy(header,offset);offset+=site.length;
    header.writeBigInt64BE(BigInt(+start),offset);offset+=8;header.writeBigInt64BE(BigInt(+end),offset);offset+=8;
    header.writeInt32BE(rows.length,offset);
    const hash=createHash('sha256').update(header);
    for(const row of rows) {
        const frame=Buffer.alloc(58);let cursor=0;
        frame.writeBigInt64BE(BigInt(+row.timestamp),cursor);cursor+=8;
        frame.writeInt32BE(row.tariff_id,cursor);cursor+=4;
        frame.writeUInt8(row.tariff_schedule_id==null?0:1,cursor++);
        frame.writeInt32BE(row.tariff_schedule_id??0,cursor);cursor+=4;
        for(const value of [row.load_power,row.solar_power,row.grid_power,row.battery_power]) {frame.writeDoubleBE(value,cursor);cursor+=8;}
        frame.writeUInt8(row.battery_soc==null?0:1,cursor++);frame.writeDoubleBE(row.battery_soc??0,cursor);
        hash.update(frame);
    }
    return hash.digest('hex');
}
