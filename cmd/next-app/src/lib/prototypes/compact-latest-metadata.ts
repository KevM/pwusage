import {createHash} from 'node:crypto';
import type {EnergyData} from '../db-types';
export interface LatestSample {timestamp:number;batterySoc:number|null;batteryPower:number;solarPower:number;gridPower:number;loadPower:number}
export interface LatestMetadata {version:1;sample:LatestSample;soc:{timestamp:number;value:number}|null}
export interface LatestIdentity {siteId:string;start:Date;end:Date;archiveChecksum:string}
function digest(data:LatestMetadata,id:LatestIdentity):string {
    const s=data.sample;
    const int=(n:number)=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;};
    const time=(n:number)=>{const b=Buffer.alloc(8);b.writeBigInt64BE(BigInt(n));return b;};
    const float=(n:number)=>{const b=Buffer.alloc(8);b.writeDoubleBE(n===0?0:n);return b;};
    const flag=(v:boolean)=>Buffer.from([v?1:0]),site=Buffer.from(id.siteId,'utf8');
    return createHash('sha256').update(Buffer.concat([Buffer.from('CEL1'),int(site.length),site,time(+id.start),time(+id.end),Buffer.from(id.archiveChecksum),int(data.version),
        time(s.timestamp),... [s.loadPower,s.solarPower,s.gridPower,s.batteryPower].map(float),flag(s.batterySoc!==null),float(s.batterySoc??0),
        flag(data.soc!==null),time(data.soc?.timestamp??0),float(data.soc?.value??0)])).digest('hex');
}
export function verifyLatestMetadata(data:LatestMetadata,checksum:string,id:LatestIdentity):void {
    const s=data?.sample,soc=data?.soc;
    if(data?.version!==1 || !s || !Number.isSafeInteger(s.timestamp) || s.timestamp<+id.start || s.timestamp>=+id.end
        || [s.loadPower,s.solarPower,s.gridPower,s.batteryPower].some(v=>!Number.isFinite(v))
        || (s.batterySoc!==null&&!Number.isFinite(s.batterySoc)) || soc===undefined
        || (soc!==null&&(!Number.isSafeInteger(soc.timestamp)||soc.timestamp<+id.start||soc.timestamp>s.timestamp||!Number.isFinite(soc.value)))
        || checksum!==digest(data,id))throw new Error('Latest metadata mismatch');
}
export function buildLatestMetadata(rows:EnergyData[],id:LatestIdentity):{data:LatestMetadata;checksum:string} {
    const last=rows.at(-1);if(!last)throw new Error('No day samples');
    const charge=rows.findLast(r=>r.battery_soc!==null&&r.battery_soc!==undefined);
    const data:LatestMetadata={version:1,sample:{timestamp:+last.timestamp,batterySoc:last.battery_soc??null,batteryPower:last.battery_power,
        solarPower:last.solar_power,gridPower:last.grid_power,loadPower:last.load_power},soc:charge?{timestamp:+charge.timestamp,value:charge.battery_soc!}:null};
    const checksum=digest(data,id);verifyLatestMetadata(data,checksum,id);return {data,checksum};
}
