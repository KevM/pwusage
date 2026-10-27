import { createHash } from 'node:crypto';
import { type DayRollup,type EnergySample } from './compact-energy';
import { isAttributionComplete,rollupSamples,validateDayAttribution,type DayAttribution } from './day-attribution';

export interface SummarizedHistoryDay {
    siteId:string;start:Date;end:Date;attributionComplete:boolean;summaries:DayRollup[];
    sampleCount:number;first:Date;last:Date;maxInteriorGapMs:number;checksum:string;checksumVersion:3;
    /** Version 3 only: the segment timeline the summaries were derived from. */
    attribution:DayAttribution;
}
function digest(day:Omit<SummarizedHistoryDay,'checksum'>):string {
    const int=(value:number)=>{const bytes=Buffer.alloc(4);bytes.writeInt32BE(value);return bytes;};
    const time=(value:Date)=>{const bytes=Buffer.alloc(8);bytes.writeBigInt64BE(BigInt(+value));return bytes;};
    const float=(value:number)=>{const bytes=Buffer.alloc(8);bytes.writeDoubleBE(value);return bytes;};
    const flag=(value:boolean)=>Buffer.from([value?1:0]);
    const site=Buffer.from(day.siteId,'utf8');
    const rows=[...day.summaries].sort((a,b)=>a.tariff_id-b.tariff_id || (a.tariff_schedule_id===null?-1:b.tariff_schedule_id===null?1:a.tariff_schedule_id-b.tariff_schedule_id));
    const parts=[Buffer.from('CEM3'),int(site.length),site,time(day.start),time(day.end),flag(day.attributionComplete),int(day.sampleCount),
        time(day.first),time(day.last),int(day.maxInteriorGapMs)];
    {
        // Attribution precedes the summaries, mirrored by verify_compact_day_metadata.
        const revision=Buffer.from(day.attribution!.timelineRevision,'utf8');
        parts.push(int(revision.length),revision,int(day.attribution!.segments.length));
        for(const s of day.attribution!.segments) parts.push(int(s.offset),int(s.tariffId),flag(s.scheduleId!==null),int(s.scheduleId??0));
    }
    parts.push(int(rows.length));
    for(const s of rows) parts.push(int(s.tariff_id),flag(s.tariff_schedule_id!==null),int(s.tariff_schedule_id??0),
        ...[s.load_power,s.solar_power,s.grid_power,s.battery_power,s.sample_import_wh,s.sample_export_wh,s.sample_charge_wh,s.sample_discharge_wh].map(float),int(s.sample_count));
    return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}
const coverage=(timestamps:Date[])=>({sampleCount:timestamps.length,first:timestamps[0],last:timestamps.at(-1)!,
    maxInteriorGapMs:timestamps.reduce((gap,t,i)=>i ? Math.max(gap,+t-+timestamps[i-1]) : gap,0)});
/** Format 2 days: summaries from samples × segments, attribution_complete from the segments. */
export function buildDayMetadataV3(samples:EnergySample[],attribution:DayAttribution,start:Date,end:Date):SummarizedHistoryDay {
    if (!samples.length) throw new Error('No day samples');
    const day={checksumVersion:3 as const,siteId:samples[0].site_id,start,end,attributionComplete:isAttributionComplete(attribution),
        attribution,summaries:rollupSamples(samples,attribution,start,end),...coverage(samples.map(s=>s.timestamp))};
    return {...day,checksum:digest(day)};
}
function attributionMismatch(day:SummarizedHistoryDay):boolean {
    if (day.checksumVersion!==3) return true;
    try { validateDayAttribution(day.attribution!,day.start,day.end); } catch { return true; }
    return day.attributionComplete!==isAttributionComplete(day.attribution!);
}
export function verifyDayMetadata(day:SummarizedHistoryDay):void {
    const ids=new Set<string>();
    if (attributionMismatch(day) || !day.siteId || !Number.isSafeInteger(day.sampleCount) || day.sampleCount<1 || day.sampleCount>4096
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
