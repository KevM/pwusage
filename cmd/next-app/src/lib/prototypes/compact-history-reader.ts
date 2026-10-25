import {IncompleteTariffAttributionError} from '../billing-availability';
/** Opt-in integration prototype; no remote storage, Tesla calls or default activation. */
import type { EnergyData } from '../db-types';
import type { LatestEnergySnapshot,LatestBatterySoc,CycleAggregateRow, CycleAggregatesAndCoverage, DailyCoverageStat, EnergyHistoryReader } from '../energy-repo';
import { addDaysInSiteTimezone, formatSiteDate, getSiteMidnight } from '../date-utils';
import { verifyDayMetadata,type SummarizedHistoryDay } from './compact-day-metadata';
import { decodeDay, decodeDaySamples, rollupDay, type DayArchive, type DayRollup } from './compact-energy';
import { attributeSamples, type DayAttribution } from './day-attribution';

export interface FinalizedHistoryDay {
    /** Set only after auditing schedule ownership/existence against original historical tariffs. */
    attributionComplete: boolean;
    siteId: string;
    start: Date;
    end: Date;
    archive: DayArchive;
    summaries: DayRollup[];
    /** Format 2 records only: samples carry no tariff IDs; each takes the segment covering its label. */
    attribution?: DayAttribution;
}
export interface HistorySnapshot { raw: EnergyData[]; days: FinalizedHistoryDay[] }
export interface AggregateHistorySnapshot { timezone:string|null; fullDays:SummarizedHistoryDay[]; detail:HistorySnapshot }
export interface ScalarHistorySnapshot {attributionComplete?:boolean;timezone:string|null;aggregates:CycleAggregateRow[];coverage:DailyCoverageStat[];detail:HistorySnapshot}
export interface HistorySnapshotStore {
    getLatestEnergyData?(siteId:string,asOf?:Date):Promise<LatestEnergySnapshot|null>;
    getLatestBatterySoc?(siteId:string,since:Date):Promise<LatestBatterySoc|null>;
    getLatestTimestamp?(siteId:string):Promise<Date|null>;
    /** Full-day digests verified inside PostgreSQL before projecting scalar results. */
    readScalarSnapshot?(siteId:string,start:Date,end:Date,mode:{billing:boolean;coverage:boolean}):Promise<ScalarHistorySnapshot>;
    /** One coherent revision: complete intersecting local days plus raw rows in [start,end).
     * Finalized attributionComplete is earned by the historical tariff audit, not by non-null IDs.
     * Raw sample attribution remains the importer's responsibility.
     */
    readSnapshot(siteId: string, start: Date, end: Date): Promise<HistorySnapshot>;
    hasData?(siteId: string): Promise<boolean>;
    readAggregateSnapshot?(siteId:string,start:Date,end:Date):Promise<AggregateHistorySnapshot>;
}
const measurements = ['load_power', 'solar_power', 'grid_power', 'battery_power'] as const;
const sampleFields = [...measurements, 'battery_soc', 'tariff_id', 'tariff_schedule_id'] as const;

interface ValidatedAggregateSnapshot {fullDays:SummarizedHistoryDay[];detail:{rows:EnergyData[];days:FinalizedHistoryDay[]}}
export class CompactHistoryReader implements EnergyHistoryReader {
    constructor(private readonly store: HistorySnapshotStore, private readonly timezone: string) {}

    private async read(siteId: string, start: Date, end: Date, snapshot?:HistorySnapshot): Promise<{ rows: EnergyData[]; days: FinalizedHistoryDay[] }> {
        if (!siteId || !Number.isSafeInteger(+start) || !Number.isSafeInteger(+end)) throw new Error('Invalid history range');
        if (start >= end) return { rows: [], days: [] };
        const data = snapshot ?? await this.store.readSnapshot(siteId, start, end);
        const days = [...data.days].sort((a, b) => +a.start - +b.start);
        const samples = new Map<number, EnergyData>();
        let priorEnd = -Infinity;
        for (const day of days) {
            if (day.siteId !== siteId || +day.start !== +getSiteMidnight(day.start, this.timezone)
                || +day.end !== +addDaysInSiteTimezone(day.start, 1, this.timezone)
                || day.start >= end || day.end <= start || +day.start < priorEnd) throw new Error('Invalid finalized day');
            priorEnd = +day.end;
            const identity = { siteId, start: day.start, end: day.end };
            const decoded = day.attribution ? attributeSamples(decodeDaySamples(day.archive, identity), day.attribution, day.start, day.end)
                : decodeDay(day.archive, identity);
            // Prototype verifies every snapshot. A production store can trust an immutable,
            // reconciled revision and fetch just summaries for whole-day billing.
            const expected = rollupDay(decoded, day.start);
            if (expected.length !== day.summaries.length) throw new Error('Summary mismatch');
            for (const summary of expected) {
                const actual = day.summaries.find(s => s.tariff_id === summary.tariff_id && s.tariff_schedule_id === summary.tariff_schedule_id);
                if (!actual || Object.keys(summary).some(key => {
                    const field = key as keyof DayRollup;
                    return field === 'day' ? +actual.day !== +summary.day : !Object.is(actual[field], summary[field]);
                })) throw new Error('Summary mismatch');
            }
            for (const sample of decoded) samples.set(+sample.timestamp, sample);
        }
        const rawTimes = new Set<number>();
        for (const sample of data.raw) {
            if (sample.site_id !== siteId || !Number.isSafeInteger(+sample.timestamp) || sample.timestamp < start || sample.timestamp >= end
                || rawTimes.has(+sample.timestamp) || !Number.isSafeInteger(sample.tariff_id)
                || (sample.tariff_schedule_id !== null && !Number.isSafeInteger(sample.tariff_schedule_id))
                || (sample.battery_soc !== null && !Number.isFinite(sample.battery_soc))
                || measurements.some(key => !Number.isFinite(sample[key]))) throw new Error('Invalid raw history');
            rawTimes.add(+sample.timestamp);
            const finalized = days.some(d => sample.timestamp >= d.start && sample.timestamp < d.end);
            if (finalized) {
                const previous = samples.get(+sample.timestamp);
                if (!previous || sampleFields.some(key => !Object.is(previous[key], sample[key]))) throw new Error('Conflicting finalized data');
            } else {
                samples.set(+sample.timestamp, sample);
            }
        }
        return { rows: [...samples.values()].filter(r => r.timestamp >= start && r.timestamp < end)
            .sort((a, b) => +a.timestamp - +b.timestamp), days };
    }

    async getRawEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]> {
        return (await this.read(siteId, start, end)).rows;
    }

    private async aggregateSnapshot(siteId:string,start:Date,end:Date):Promise<ValidatedAggregateSnapshot> {
        if (!this.store.readAggregateSnapshot) return {fullDays:[],detail:await this.read(siteId,start,end)};
        const snapshot=await this.store.readAggregateSnapshot(siteId,start,end);
        if (snapshot.timezone!==null && snapshot.timezone!==this.timezone) throw new Error('History timezone mismatch');
        const fullDays=[...snapshot.fullDays].sort((a,b)=>+a.start-+b.start);
        let priorEnd=-Infinity;
        for (const day of fullDays) {
            if (day.siteId!==siteId || +day.start!==+getSiteMidnight(day.start,this.timezone)
                || +day.end!==+addDaysInSiteTimezone(day.start,1,this.timezone) || day.start<start || day.end>end
                || +day.start<priorEnd) throw new Error('Invalid finalized day');
            priorEnd=+day.end;verifyDayMetadata(day);
        }
        const detail=await this.read(siteId,start,end,snapshot.detail);
        if (detail.rows.some(r=>fullDays.some(d=>r.timestamp>=d.start&&r.timestamp<d.end))
            || detail.days.some(d=>fullDays.some(f=>d.start<f.end&&d.end>f.start))) throw new Error('Conflicting finalized data');
        return {fullDays,detail};
    }

    private async projectedRequest(siteId:string,start:Date,end:Date,mode:{billing:boolean;coverage:boolean}):Promise<CycleAggregatesAndCoverage|null> {
        if (!this.store.readScalarSnapshot) return null;
        const snapshot=await this.store.readScalarSnapshot(siteId,start,end,mode);
        if(snapshot.timezone!==null && snapshot.timezone!==this.timezone) throw new Error('History timezone mismatch');
        const ids=new Set<string>();
        for(const row of snapshot.aggregates) {
            const key=JSON.stringify([+row.day,row.tariff_id,row.tariff_schedule_id]);
            if(ids.has(key) || +row.day!==+getSiteMidnight(row.day,this.timezone) || row.day<start || addDaysInSiteTimezone(row.day,1,this.timezone)>end
                || !Number.isSafeInteger(row.tariff_id) || (row.tariff_schedule_id===null ? snapshot.attributionComplete!==false : !Number.isSafeInteger(row.tariff_schedule_id))
                || measurements.some(field=>!Number.isFinite(row[field]))) throw new Error('Invalid scalar history');
            ids.add(key);
        }
        const coverageKeys=new Set<string>();
        for(const stat of snapshot.coverage) {
            if(coverageKeys.has(stat.localDayKey) || !stat.first || !stat.last || !Number.isSafeInteger(+stat.first) || !Number.isSafeInteger(+stat.last)
                || stat.first<start || stat.last>=end || stat.first>stat.last || !Number.isSafeInteger(stat.count) || stat.count<1
                || !Number.isSafeInteger(stat.maxInteriorGapMs) || stat.maxInteriorGapMs<0
                || formatSiteDate(stat.first,this.timezone)!==stat.localDayKey || formatSiteDate(stat.last,this.timezone)!==stat.localDayKey) throw new Error('Invalid scalar coverage');
            coverageKeys.add(stat.localDayKey);
        }
        const detail=await this.read(siteId,start,end,snapshot.detail);
        // Membership checks use day bounds once, not timezone conversion per sample/summary.
        const scalarStarts=new Set(snapshot.aggregates.map(a=>+a.day));
        const scalarWindows=[...scalarStarts].map(start=>({start,end:+addDaysInSiteTimezone(new Date(start),1,this.timezone)}));
        const coveredWindows=snapshot.coverage.map(stat=>{
            const start=getSiteMidnight(stat.first!,this.timezone);
            return {start:+start,end:+addDaysInSiteTimezone(start,1,this.timezone)};
        });
        const excludedWindows=[...scalarWindows,...coveredWindows];
        if(detail.days.some(d=>scalarStarts.has(+d.start)||coverageKeys.has(formatSiteDate(d.start,this.timezone)))
            || detail.rows.some(r=>excludedWindows.some(w=>+r.timestamp>=w.start&&+r.timestamp<w.end))) throw new Error('Conflicting finalized data');
        if(mode.billing&&snapshot.attributionComplete===false)throw new IncompleteTariffAttributionError();
        const aggregate={fullDays:[],detail};
        const aggregates=mode.billing?[...snapshot.aggregates,...this.cycleFromSnapshot(aggregate,start,end)]:[];
        const coverage=mode.coverage?[...snapshot.coverage,...this.coverageFromSnapshot(aggregate,this.timezone)]:[];
        return {aggregates:aggregates.sort((a,b)=>+a.day-+b.day||a.tariff_id-b.tariff_id||(a.tariff_schedule_id??0)-(b.tariff_schedule_id??0)),
            coverage:coverage.sort((a,b)=>a.localDayKey.localeCompare(b.localDayKey))};
    }

    async getLatestEnergyData(siteId:string,asOf?:Date):Promise<LatestEnergySnapshot|null> {
        if(!this.store.getLatestEnergyData)throw new Error('Store requires bounded latest energy query');
        return this.store.getLatestEnergyData(siteId,asOf);
    }
    async getLatestBatterySoc(siteId:string,since:Date):Promise<LatestBatterySoc|null> {
        if(!this.store.getLatestBatterySoc)throw new Error('Store requires scalar SOC query');
        return this.store.getLatestBatterySoc(siteId,since);
    }
    async getLatestTimestamp(siteId:string):Promise<Date|null> {
        if(!this.store.getLatestTimestamp) throw new Error('Store requires bounded freshness query');
        return this.store.getLatestTimestamp(siteId);
    }

    async hasData(siteId: string): Promise<boolean> {
        if (this.store.hasData) return this.store.hasData(siteId);
        // In-memory prototype stores can return their full snapshot. SQL stores must
        // provide the bounded indexed existence query instead.
        return (await this.read(siteId,new Date(0),new Date(8640000000000000))).rows.length > 0;
    }

    private scalarWindows(start:Date,end:Date):{start:Date;end:Date}[] {
        if(!Number.isSafeInteger(+start)||!Number.isSafeInteger(+end))throw new Error('Invalid history range');
        if(start>=end)return [];
        if(+end-+start<=366*86400000)return [{start,end}];
        const windows:{start:Date;end:Date}[]=[];
        for(let cursor=start;cursor<end;) {
            if(windows.length===32)throw new Error('Scalar history request exceeds 32 windows');
            const boundary=addDaysInSiteTimezone(getSiteMidnight(cursor,this.timezone),360,this.timezone);
            const until=boundary<end?boundary:end;
            windows.push({start:cursor,end:until});cursor=until;
        }
        return windows;
    }

    async getDailyCoverage(siteId: string, start: Date, end: Date, timezone: string): Promise<DailyCoverageStat[]> {
        if (timezone !== this.timezone) throw new Error('History timezone mismatch');
        const windows=this.scalarWindows(start,end);
        if(!windows.length)return [];
        if(windows.length>1) {
            const result:DailyCoverageStat[]=[];
            for(const window of windows)result.push(...await this.getDailyCoverage(siteId,window.start,window.end,timezone));
            return result;
        }
        const projected=await this.projectedRequest(siteId,start,end,{billing:false,coverage:true});
        if(projected) return projected.coverage;
        const aggregate = await this.aggregateSnapshot(siteId,start,end);
        return this.coverageFromSnapshot(aggregate,timezone);
    }

    private coverageFromSnapshot(aggregate:ValidatedAggregateSnapshot,timezone:string):DailyCoverageStat[] {
        const rows = aggregate.detail.rows;
        const coverage = new Map<string,DailyCoverageStat>(aggregate.fullDays.map(d=>[formatSiteDate(d.start,timezone),
            {localDayKey:formatSiteDate(d.start,timezone),count:d.sampleCount,first:d.first,last:d.last,maxInteriorGapMs:d.maxInteriorGapMs}]));
        for (const row of rows) {
            const key = formatSiteDate(row.timestamp,timezone);
            let stat = coverage.get(key);
            if (!stat) { stat = { localDayKey:key,count:0,first:row.timestamp,last:null,maxInteriorGapMs:0 }; coverage.set(key,stat); }
            if (stat.last) stat.maxInteriorGapMs = Math.max(stat.maxInteriorGapMs,+row.timestamp-+stat.last);
            stat.last = row.timestamp; stat.count++;
        }
        return [...coverage.values()].sort((a,b)=>a.localDayKey.localeCompare(b.localDayKey));
    }

    async getCycleAggregates(siteId: string, start: Date, end: Date): Promise<CycleAggregateRow[]> {
        const windows=this.scalarWindows(start,end);
        if(!windows.length)return [];
        if(windows.length>1) {
            const result:CycleAggregateRow[]=[];
            for(const window of windows)result.push(...await this.getCycleAggregates(siteId,window.start,window.end));
            return result;
        }
        const projected=await this.projectedRequest(siteId,start,end,{billing:true,coverage:false});
        if(projected) return projected.aggregates;
        const aggregate = await this.aggregateSnapshot(siteId,start,end);
        return this.cycleFromSnapshot(aggregate,start,end);
    }

    private cycleFromSnapshot(aggregate:ValidatedAggregateSnapshot,start:Date,end:Date):CycleAggregateRow[] {
        const { rows, days } = aggregate.detail;
        if (days.some(d => d.attributionComplete !== true && rows.some(r => r.timestamp >= d.start && r.timestamp < d.end))) throw new IncompleteTariffAttributionError();
        if (aggregate.fullDays.some(d=>!d.attributionComplete)) throw new IncompleteTariffAttributionError();
        const fullDays = days.filter(d => d.start >= start && d.end <= end);
        const summaries = [...aggregate.fullDays.flatMap(d=>d.summaries),...fullDays.flatMap(d => d.summaries)];
        const remaining = rows.filter(r => !fullDays.some(d => r.timestamp >= d.start && r.timestamp < d.end));
        const groups = new Map<number, EnergyData[]>();
        // read() sorts timestamps, so each local-day boundary is resolved only once.
        let dayStart:Date|undefined,dayEnd:Date|undefined;
        for (const sample of remaining) {
            if(!dayStart||!dayEnd||sample.timestamp<dayStart||sample.timestamp>=dayEnd) {
                dayStart=getSiteMidnight(sample.timestamp,this.timezone);
                dayEnd=addDaysInSiteTimezone(dayStart,1,this.timezone);
            }
            const day=+dayStart;
            const group = groups.get(day) ?? [];
            group.push(sample); groups.set(day, group);
        }
        for (const [day, samples] of groups) summaries.push(...rollupDay(samples, new Date(day)));
        if (summaries.some(s => s.tariff_schedule_id === null)) throw new IncompleteTariffAttributionError();
        return summaries.map(s => ({ day: s.day, tariff_id: s.tariff_id, tariff_schedule_id: s.tariff_schedule_id,
            load_power: s.load_power, solar_power: s.solar_power, grid_power: s.grid_power, battery_power: s.battery_power }))
            .sort((a, b) => +a.day - +b.day || a.tariff_id - b.tariff_id || (a.tariff_schedule_id ?? 0) - (b.tariff_schedule_id ?? 0));
    }

    async getCycleAggregatesAndCoverage(siteId:string,start:Date,end:Date,timezone:string):Promise<CycleAggregatesAndCoverage> {
        if (timezone!==this.timezone) throw new Error('History timezone mismatch');
        const windows=this.scalarWindows(start,end);
        if(!windows.length)return {aggregates:[],coverage:[]};
        if(windows.length>1) {
            const result:CycleAggregatesAndCoverage={aggregates:[],coverage:[]};
            for(const window of windows) {
                const chunk=await this.getCycleAggregatesAndCoverage(siteId,window.start,window.end,timezone);
                result.aggregates.push(...chunk.aggregates);result.coverage.push(...chunk.coverage);
            }
            return result;
        }
        const projected=await this.projectedRequest(siteId,start,end,{billing:true,coverage:true});
        if(projected) return projected;
        const snapshot=await this.aggregateSnapshot(siteId,start,end);
        return {aggregates:this.cycleFromSnapshot(snapshot,start,end),coverage:this.coverageFromSnapshot(snapshot,timezone)};
    }

    async getBucketedEnergyData(siteId: string, start: Date, end: Date): Promise<EnergyData[]> {
        const rows = await this.getRawEnergyData(siteId, start, end);
        const buckets = new Map<string, EnergyData>();
        for (const row of rows) {
            const timestamp = Math.floor(+row.timestamp / 900000) * 900000;
            const key = JSON.stringify([timestamp, row.tariff_id, row.tariff_schedule_id]);
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = { timestamp: new Date(timestamp), sample_timestamp: row.timestamp, site_id: siteId,
                    tariff_id: row.tariff_id, tariff_schedule_id: row.tariff_schedule_id, sample_count: 0,
                    load_power: 0, solar_power: 0, grid_power: 0, battery_power: 0, battery_soc: null };
                buckets.set(key, bucket);
            }
            bucket.sample_count = (bucket.sample_count ?? 0) + 1;
            bucket.sample_timestamp = row.timestamp;
            for (const field of measurements) bucket[field] += row[field];
        }
        return [...buckets.values()].sort((a, b) => +a.timestamp - +b.timestamp).map((bucket, index) => {
            for (const field of measurements) bucket[field] /= bucket.sample_count ?? 1;
            return { ...bucket, id: index + 1 };
        });
    }
}
