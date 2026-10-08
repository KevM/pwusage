import { createHash } from 'node:crypto';
import type { EnergyData } from '../db-types';
import { rollupDay,type DayRollup } from './compact-energy';

export interface SummarizedHistoryDay {
    siteId:string;start:Date;end:Date;attributionComplete:boolean;summaries:DayRollup[];
    sampleCount:number;first:Date;last:Date;maxInteriorGapMs:number;checksum:string;checksumVersion?:1|2;
}
function legacyDigest(day:Omit<SummarizedHistoryDay,'checksum'>):string {
    const summaries=[...day.summaries].sort((a,b)=>a.tariff_id-b.tariff_id || (a.tariff_schedule_id??-1)-(b.tariff_schedule_id??-1))
        .map(s=>[s.site_id,+s.day,s.tariff_id,s.tariff_schedule_id,s.load_power,s.solar_power,s.grid_power,s.battery_power,
            s.sample_import_wh,s.sample_export_wh,s.sample_charge_wh,s.sample_discharge_wh,s.sample_count]);
    return createHash('sha256').update(JSON.stringify([1,day.siteId,+day.start,+day.end,day.attributionComplete,
        day.sampleCount,+day.first,+day.last,day.maxInteriorGapMs,summaries])).digest('hex');
}
function digest(day:Omit<SummarizedHistoryDay,'checksum'>):string {
    if ((day.checksumVersion??1)===1) return legacyDigest(day);
    const int=(value:number)=>{const bytes=Buffer.alloc(4);bytes.writeInt32BE(value);return bytes;};
    const time=(value:Date)=>{const bytes=Buffer.alloc(8);bytes.writeBigInt64BE(BigInt(+value));return bytes;};
    const float=(value:number)=>{const bytes=Buffer.alloc(8);bytes.writeDoubleBE(value);return bytes;};
    const flag=(value:boolean)=>Buffer.from([value?1:0]);
    const site=Buffer.from(day.siteId,'utf8');
    const rows=[...day.summaries].sort((a,b)=>a.tariff_id-b.tariff_id || (a.tariff_schedule_id===null?-1:b.tariff_schedule_id===null?1:a.tariff_schedule_id-b.tariff_schedule_id));
    const parts=[Buffer.from('CEM2'),int(site.length),site,time(day.start),time(day.end),flag(day.attributionComplete),int(day.sampleCount),
        time(day.first),time(day.last),int(day.maxInteriorGapMs),int(rows.length)];
    for(const s of rows) parts.push(int(s.tariff_id),flag(s.tariff_schedule_id!==null),int(s.tariff_schedule_id??0),
        ...[s.load_power,s.solar_power,s.grid_power,s.battery_power,s.sample_import_wh,s.sample_export_wh,s.sample_charge_wh,s.sample_discharge_wh].map(float),int(s.sample_count));
    return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}
export function buildDayMetadata(rows:EnergyData[],start:Date,end:Date,attributionComplete:boolean):SummarizedHistoryDay {
    if (!rows.length) throw new Error('No day samples');
    const day={checksumVersion:2 as const,siteId:rows[0].site_id,start,end,attributionComplete,summaries:rollupDay(rows,start),sampleCount:rows.length,
        first:rows[0].timestamp,last:rows.at(-1)!.timestamp,
        maxInteriorGapMs:rows.reduce((gap,row,i)=>i ? Math.max(gap,+row.timestamp-+rows[i-1].timestamp) : gap,0)};
    return {...day,checksum:digest(day)};
}
export function verifyDayMetadata(day:SummarizedHistoryDay):void {
    const ids=new Set<string>();
    if (!day.siteId || !Number.isSafeInteger(day.sampleCount) || day.sampleCount<1 || day.sampleCount>4096
        || !Number.isSafeInteger(+day.first) || !Number.isSafeInteger(+day.last) || day.first<day.start || day.last>=day.end || day.first>day.last
        || !Number.isSafeInteger(day.maxInteriorGapMs) || day.maxInteriorGapMs<0 || day.maxInteriorGapMs>+day.end-+day.start
        || day.summaries.reduce((n,s)=>n+s.sample_count,0)!==day.sampleCount
        || day.summaries.some(s=>{
            const key=JSON.stringify([s.tariff_id,s.tariff_schedule_id]);const duplicate=ids.has(key);ids.add(key);
            return duplicate || s.site_id!==day.siteId || +s.day!==+day.start || !Number.isSafeInteger(s.tariff_id)
                || (s.tariff_schedule_id!==null&&!Number.isSafeInteger(s.tariff_schedule_id)) || !Number.isSafeInteger(s.sample_count) || s.sample_count<1
                || [s.load_power,s.solar_power,s.grid_power,s.battery_power,s.sample_import_wh,s.sample_export_wh,s.sample_charge_wh,s.sample_discharge_wh].some(n=>!Number.isFinite(n));
        }) || day.checksum!==digest(day)) throw new Error('Day metadata mismatch');
}
