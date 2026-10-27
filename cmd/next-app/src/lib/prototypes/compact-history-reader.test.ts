import { describe, expect, it, vi } from 'vitest';
import type { EnergyData } from '../db-types';
import { EnergyRepo } from '../energy-repo';
const {queryMock}=vi.hoisted(()=>({queryMock:vi.fn(async()=>({rows:[]}))}));
vi.mock('../db',()=>({pool:{query:queryMock}}));
import * as dateUtils from '../date-utils';
import { addDaysInSiteTimezone,getSiteMidnight,formatSiteDate } from '../date-utils';
import { encodeDaySamples, rollupDay, toSample } from './compact-energy';
import { CompactHistoryReader, type HistorySnapshot, type FinalizedHistoryDay } from './compact-history-reader';
const start = new Date('2026-10-01T05:00:00Z');
const end = new Date('2026-10-02T05:00:00Z');
const row = (timestamp: Date, grid = 10): EnergyData => ({ site_id: 'site', timestamp, tariff_id: 1,
    tariff_schedule_id: 2, load_power: 20, solar_power: 3, grid_power: grid, battery_power: -2, battery_soc: null });
const rows = [row(start), row(new Date(+start + 300000), -5), row(new Date(+start + 600000), 8)];
const record = (samples: EnergyData[], from=start, until=end): FinalizedHistoryDay => {
    const segments: {offset:number;tariffId:number;scheduleId:number|null}[]=[];
    for(const sample of samples){
        const previous=segments.at(-1);
        if(!previous||previous.tariffId!==sample.tariff_id||previous.scheduleId!==sample.tariff_schedule_id)
            segments.push({offset:previous?(+sample.timestamp-+from)/60000:0,tariffId:sample.tariff_id,scheduleId:sample.tariff_schedule_id});
    }
    return {siteId:'site',start:from,end:until,attributionComplete:segments.every(s=>s.scheduleId!==null),
        attribution:{timelineRevision:'fixture',segments},archive:encodeDaySamples(samples.map(toSample),from,until,'brotli'),summaries:rollupDay(samples,from)};
};
const snapshot = (): HistorySnapshot => ({ days: [record(rows)] });
const reader = (data: HistorySnapshot) => new CompactHistoryReader({ readSnapshot: async (_siteId, from, to) => ({
    days: data.days.filter(d => d.start < to && d.end > from),
}) }, 'America/Chicago');
describe('compact historical reader', () => {
    it('reconstructs consecutive day records exactly once through EnergyRepo', async () => {
        const data = snapshot(); data.days.push(record([row(end)],end,addDaysInSiteTimezone(end,1,'America/Chicago')));
        expect(await new EnergyRepo(reader(data)).getRawEnergyData('site', start, new Date(+end + 300000))).toEqual([...rows, row(end)]);
    });
    it('filters half-open partial-day ranges before calculating bills', async () => {
        const repo = new EnergyRepo(reader(snapshot()));
        expect(await repo.getRawEnergyData('site', rows[1].timestamp, rows[2].timestamp)).toEqual([rows[1]]);
        expect(await repo.getCycleAggregates('site', rows[1].timestamp, rows[2].timestamp)).toEqual([{ day: start, tariff_id: 1,
            tariff_schedule_id: 2, load_power: 20, solar_power: 3, grid_power: -5, battery_power: -2 }]);
    });
    it('uses verified full-day totals once', async () => {
        const data = snapshot();
        expect(await reader(data).getCycleAggregates('site', start, end)).toEqual([{ day: start, tariff_id: 1,
            tariff_schedule_id: 2, load_power: 60, solar_power: 9, grid_power: 13, battery_power: -6 }]);
    });
    it('rejects corrupt archives and stale summaries', async () => {
        const corrupt = snapshot(); corrupt.days[0].archive.sha256 = 'bad';
        await expect(reader(corrupt).getRawEnergyData('site', start, end)).rejects.toThrow();
        const stale = snapshot(); stale.days[0].summaries[0].grid_power++;
        await expect(reader(stale).getCycleAggregates('site', start, end)).rejects.toThrow('Summary mismatch');
    });
    it('rejects foreign sites, wrong bounds and duplicate days', async () => {
        const foreign = snapshot(); foreign.days[0].siteId = 'other';
        const bounds = snapshot(); bounds.days[0].start = new Date(+start - 300000);
        const duplicate = snapshot(); duplicate.days.push(duplicate.days[0]);
        for (const data of [foreign, bounds, duplicate]) await expect(reader(data).getRawEnergyData('site', start, end)).rejects.toThrow();
    });
    it('keeps missing historic data absent', async () => {
        expect(await reader({ days: [] }).getRawEnergyData('site', start, end)).toEqual([]);
        expect(await reader({ days: [] }).getCycleAggregates('site', start, end)).toEqual([]);
    });
    it('preserves chart bucket averages, counts and last timestamp', async () => {
        expect(await new EnergyRepo(reader(snapshot())).getBucketedEnergyData('site', start, end)).toEqual([{ id: 1,
            timestamp: start, sample_timestamp: rows[2].timestamp, sample_count: 3, site_id: 'site',
            tariff_id: 1, tariff_schedule_id: 2, load_power: 20, solar_power: 3,
            grid_power: 13 / 3, battery_power: -2, battery_soc: null }]);
    });
    it('allows unresolved detail but refuses to invent billing attribution', async () => {
        const unknown = [{ ...rows[0], tariff_schedule_id: null }];
        const data: HistorySnapshot = { days: [record(unknown)] };
        expect(await reader(data).getRawEnergyData('site', start, end)).toEqual(unknown);
        await expect(reader(data).getCycleAggregates('site', start, end)).rejects.toThrow('Incomplete tariff attribution');
    });
});

it.each(['2026-03-08', '2026-11-01'])('preserves DST day detail and billing boundaries on %s', async date => {
    const { parseSiteLocalDateToMidnight, addDaysInSiteTimezone } = await import('../date-utils');
    const from = parseSiteLocalDateToMidnight(date, 'America/Chicago');
    const to = addDaysInSiteTimezone(from, 1, 'America/Chicago');
    const samples = Array.from({ length: (+to - +from) / 300000 }, (_, i) => row(new Date(+from + i * 300000)));
    const repo = new EnergyRepo(reader({ days: [record(samples,from,to)] }));
    expect(await repo.getRawEnergyData('site', from, to)).toEqual(samples);
    expect((await repo.getCycleAggregates('site', from, to))[0].grid_power).toBe(samples.length * 10);
});

it('preserves separate tariff groups within one chart bucket', async () => {
    const data = snapshot();
    const samples = [rows[0], { ...rows[1], tariff_id: 3, tariff_schedule_id: 4 }];
    data.days[0] = record(samples);
    const buckets = await reader(data).getBucketedEnergyData('site', start, end);
    expect(buckets.map(b => [b.tariff_id, b.tariff_schedule_id, b.sample_count, b.grid_power])).toEqual([[1, 2, 1, 10], [3, 4, 1, -5]]);
});

it('preserves web/mobile billing, TRMNL series and analysis when billing dates change', async () => {
    const { aggregateUsage } = await import('../tou-aggregation');
    const { Schedule } = await import('../schedule');
    const { adaptTeslaData } = await import('../nilm/tesla-adapter');
    const tariffs = [1, 3].map(id => ({ id, site_id: 'site', name: 'Utility', updated: start }));
    const schedules = [2, 4].map((id, index) => ({ id, season_id: id, name: 'ON_PEAK', buy_rate: index ? 0.31 : 0.30, sell_rate: 0.04,
        from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, to_hour: 24, from_minute: 0, to_minute: 0 }));
    const site = { id: 'site', timezone: 'America/Chicago', name: 'Test', installed: start, updated: start, billing_start_day: 11, json: null, tariffs };
    const schedule = new Schedule(tariffs, site.timezone);
    const historic = [row(start, -27471), row(new Date(+start + 300000), 1000)];
    const next = [{ ...row(end, 18243), tariff_id: 3, tariff_schedule_id: 4 }];
    const repo = new EnergyRepo(reader({ days: [record(historic),record(next,end,addDaysInSiteTimezone(end,1,'America/Chicago'))] }));
    const until = new Date(+end + 300000);
    for (const from of [start, historic[1].timestamp, end]) {
        const samples = [...historic, ...next].filter(r => r.timestamp >= from && r.timestamp < until);
        const reference = samples.map(r => ({ ...r, day: r.timestamp < end ? start : end }));
        const summaries = await repo.getCycleAggregates(site.id, from, until);
        const web = (priorAggregates: typeof summaries) => EnergyRepo.aggregateUsageByTOU({ siteId: site.id, start: from,
            priorAggregates, todayRaw: [], schedule, tariffMap: new Map(tariffs.map(t => [t.id, t])), scheduleMap: new Map(schedules.map(s => [s.id, s])) });
        expect(web(summaries)).toEqual(web(reference));
        expect(aggregateUsage(site, summaries, [], schedule, tariffs, schedules)).toEqual(aggregateUsage(site, reference, [], schedule, tariffs, schedules));
        const detail = await repo.getRawEnergyData(site.id, from, until);
        expect(adaptTeslaData(detail)).toEqual(adaptTeslaData(samples));
        expect(aggregateUsage(site, [], detail, schedule, tariffs, schedules)).toEqual(aggregateUsage(site, [], samples, schedule, tariffs, schedules));
    }
});

it('rejects mismatched archive envelopes', async () => {
    const envelope=snapshot();
    envelope.days[0].archive=encodeDaySamples([row(start,5)].map(toSample),new Date(+start-300000),end,'brotli');
    await expect(reader(envelope).getRawEnergyData('site',start,end)).rejects.toThrow('Archive identity mismatch');
});

it('refuses billing for a day whose historical attribution audit is incomplete', async () => {
    const data = snapshot(); data.days[0].attributionComplete = false;
    expect(await reader(data).getRawEnergyData('site', start, end)).toEqual(rows);
    await expect(reader(data).getCycleAggregates('site', start, end)).rejects.toThrow('Incomplete tariff attribution');
    await expect(reader(data).getCycleAggregates('site', rows[1].timestamp, rows[2].timestamp)).rejects.toThrow('Incomplete tariff attribution');
});

it('reports day-record coverage and preserves actual gaps', async () => {
    const { planImport } = await import('../importer/import-planner');
    const data = snapshot();
    const repo = new EnergyRepo(reader(data));
    const coverage = await repo.getDailyCoverage('site',start,end,'America/Chicago');
    expect(coverage).toEqual([{ localDayKey:'2026-10-01', count:3, first:start, last:rows[2].timestamp, maxInteriorGapMs:300000 }]);
    const options = { requestedRange:{start,end},existingCoverage:coverage,timezone:'America/Chicago',now:new Date(+end+86400000) };
    expect(planImport(options)).toHaveLength(1); // Real end-of-day gap, never treat a partial archive as complete.
    const complete = Array.from({length:288},(_,i)=>row(new Date(+start+i*300000)));
    const whole = {days:[record(complete)]};
    expect(planImport({...options,existingCoverage:await new EnergyRepo(reader(whole)).getDailyCoverage('site',start,end,'America/Chicago')})).toEqual([]);
});

it('filters partial-day coverage and rejects a stale timezone', async () => {
    const repo = new EnergyRepo(reader(snapshot()));
    expect(await repo.getDailyCoverage('site',rows[1].timestamp,rows[2].timestamp,'America/Chicago')).toEqual([
        { localDayKey:'2026-10-01',count:1,first:rows[1].timestamp,last:rows[1].timestamp,maxInteriorGapMs:0 }]);
    await expect(repo.getDailyCoverage('site',start,end,'America/New_York')).rejects.toThrow('History timezone mismatch');
});

it('recognizes archive-only history in hasData', async () => {
    expect(await new EnergyRepo(reader(snapshot())).hasData('site')).toBe(true);
    expect(await new EnergyRepo(reader({days:[]})).hasData('site')).toBe(false);
});

it('shares one coherent snapshot between billing and coverage within a request',async()=>{
    const {buildDayMetadataV3}=await import('./compact-day-metadata');
    let reads=0;
    const history=new CompactHistoryReader({readSnapshot:async()=>{throw new Error('Unexpected detail query');},
        readAggregateSnapshot:async()=>{reads++;return {timezone:'America/Chicago',fullDays:[buildDayMetadataV3(rows.map(toSample),snapshot().days[0].attribution,start,end)],detail:{days:[]}};}},'America/Chicago');
    const repo=new EnergyRepo(history);
    const result=await repo.getCycleAggregatesAndCoverage('site',start,end,'America/Chicago');
    expect(reads).toBe(1);
    expect(result.aggregates[0].grid_power).toBe(13);
    expect(result.coverage[0].count).toBe(3);
});

it('delegates scalar freshness through the repository without a detail snapshot',async()=>{
    const expected=new Date('2026-01-02T00:00:00Z');
    const history=new CompactHistoryReader({readSnapshot:async()=>{throw new Error('Unexpected payload read');},getLatestTimestamp:async()=>expected},'UTC');
    queryMock.mockClear();
    expect(await new EnergyRepo(history).getLatestTimestamp('site')).toEqual(expected);
    expect(queryMock).not.toHaveBeenCalled();
});

describe('multi-year scalar reads',()=>{
    it.each(['coverage','billing','combined'] as const)('partitions %s on local-day boundaries and combines results once',async kind=>{
        const from=new Date('2024-01-01T18:00:00Z'),until=addDaysInSiteTimezone(from,800,'America/Chicago');
        const requests:{start:Date;end:Date}[]=[];
        const history=new CompactHistoryReader({readSnapshot:async()=>{throw new Error('Unexpected payload');},readScalarSnapshot:async(_site,start,end,mode)=>{
            if(+end-+start>366*86400000)throw new Error('Unbounded store read');
            requests.push({start,end});
            const day=+start===+getSiteMidnight(start,'America/Chicago')?start:addDaysInSiteTimezone(getSiteMidnight(start,'America/Chicago'),1,'America/Chicago');
            return {timezone:'America/Chicago',detail:{days:[]},
                aggregates:mode.billing?[{day,tariff_id:1,tariff_schedule_id:2,load_power:1,solar_power:0,grid_power:1,battery_power:0}]:[],
                coverage:mode.coverage?[{localDayKey:formatSiteDate(day,'America/Chicago'),count:1,first:day,last:day,maxInteriorGapMs:0}]:[]};
        }},'America/Chicago');
        const result=kind==='coverage'?{coverage:await history.getDailyCoverage('site',from,until,'America/Chicago'),aggregates:[]}:
            kind==='billing'?{aggregates:await history.getCycleAggregates('site',from,until),coverage:[]}:
            await history.getCycleAggregatesAndCoverage('site',from,until,'America/Chicago');
        expect(requests).toHaveLength(3);expect(requests[0].start).toEqual(from);expect(requests.at(-1)!.end).toEqual(until);
        for(let i=1;i<requests.length;i++){expect(requests[i].start).toEqual(requests[i-1].end);expect(requests[i].start).toEqual(getSiteMidnight(requests[i].start,'America/Chicago'));}
        expect(result.coverage).toHaveLength(kind==='billing'?0:3);expect(result.aggregates).toHaveLength(kind==='coverage'?0:3);
        expect(new Set(result.coverage.map(r=>r.localDayKey)).size).toBe(result.coverage.length);
    });
    it('rejects oversized and invalid scalar windows before any database read',async()=>{
        const read=vi.fn(async()=>({timezone:'UTC',aggregates:[],coverage:[],detail:{days:[]}}));
        const history=new CompactHistoryReader({readSnapshot:async()=>({days:[]}),readScalarSnapshot:read},'UTC');
        await expect(history.getDailyCoverage('site',new Date('1970-01-01'),new Date('2090-01-01'),'UTC')).rejects.toThrow('Scalar history request exceeds 32 windows');
        await expect(history.getCycleAggregates('site',new Date(NaN),new Date())).rejects.toThrow('Invalid history range');
        expect(read).not.toHaveBeenCalled();
    });
});

it('does not return partial multi-year results when a later window fails integrity checks',async()=>{
    let calls=0;
    const history=new CompactHistoryReader({readSnapshot:async()=>({days:[]}),readScalarSnapshot:async()=>{
        calls++;if(calls===2)throw new Error('Day metadata mismatch');
        return {timezone:'UTC',aggregates:[],coverage:[],detail:{days:[]}};
    }},'UTC');
    await expect(history.getDailyCoverage('site',new Date('2023-01-01'),new Date('2026-01-01'),'UTC')).rejects.toThrow('Day metadata mismatch');
    expect(calls).toBe(2);
});

it('delegates latest power and charge without range/detail reads',async()=>{
    const sample={timestamp:start,batterySoc:null,batteryPower:-2,solarPower:3,gridPower:10,loadPower:20};
    const history=new CompactHistoryReader({readSnapshot:async()=>{throw new Error('Unexpected detail');},getLatestEnergyData:async()=>sample,getLatestBatterySoc:async()=>({timestamp:start,value:50})},'UTC');
    const repo=new EnergyRepo(history);queryMock.mockClear();
    expect(await repo.getLatestEnergyData('site',end)).toEqual(sample);
    expect(await repo.getLatestBatterySoc('site',start)).toEqual({timestamp:start,value:50});
    expect(queryMock).not.toHaveBeenCalled();
});

it('bounds timezone conversions for a month mixing scalar summaries and detailed day records',async()=>{
    const before=new Date(+start+30*86400000);
    const aggregates=Array.from({length:4},(_,i)=>({day:new Date(+start+i*86400000),tariff_id:1,tariff_schedule_id:2,
        load_power:20,solar_power:3,grid_power:10,battery_power:-2}));
    const raw=Array.from({length:22*288},(_,i)=>row(new Date(+start+4*86400000+i*300000)));
    const days=Array.from({length:22},(_,i)=>{const from=new Date(+start+(4+i)*86400000);return record(raw.slice(i*288,(i+1)*288),from,new Date(+from+86400000));});
    const midnight=vi.spyOn(dateUtils,'getSiteMidnight');
    try {
        const history=new CompactHistoryReader({readSnapshot:async()=>{throw new Error('Unexpected detail query');},
            readScalarSnapshot:async()=>({timezone:'America/Chicago',aggregates,coverage:[],detail:{days}})},'America/Chicago');
        const result=await history.getCycleAggregates('site',start,before);
        expect(result.reduce((sum,r)=>sum+r.grid_power,0)).toBe(40+raw.length*10);
        expect(result).toHaveLength(26);
        expect(midnight.mock.calls.length).toBeLessThan(100);
    }finally {midnight.mockRestore();}
});
