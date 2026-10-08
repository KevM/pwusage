import { expect,it } from 'vitest';
import { ProtocolCounter } from './postgres-transfer-meter';
const frame=(tag:string,payload:Buffer)=>{
    const out=Buffer.alloc(5+payload.length);out[0]=tag.charCodeAt(0);out.writeUInt32BE(4+payload.length,1);payload.copy(out,5);return out;
};
it('counts returned bytes and rows across fragmented PostgreSQL frames',()=>{
    const counter=new ProtocolCounter('backend');
    const bytes=Buffer.concat([frame('D',Buffer.from('sample')),frame('Z',Buffer.from('I'))]);
    counter.push(bytes.subarray(0,3));counter.push(bytes.subarray(3));
    expect(counter.metrics).toEqual({bytes:bytes.length,rows:1,requests:0,selectRequests:0});
});
it('skips frontend startup and counts simple and extended SELECT requests',()=>{
    const counter=new ProtocolCounter('frontend');
    const startup=Buffer.alloc(8);startup.writeUInt32BE(8);startup.writeUInt32BE(196608,4);
    counter.push(Buffer.concat([startup,frame('Q',Buffer.from('BEGIN\0')),frame('P',Buffer.from('\0SELECT 1\0\0\0'))]));
    expect(counter.metrics.requests).toBe(2);expect(counter.metrics.selectRequests).toBe(1);
});
it('bounds frame size before buffering a pathological response',()=>{
    const counter=new ProtocolCounter('backend');const bytes=Buffer.alloc(5);bytes[0]=68;bytes.writeUInt32BE(30*1024*1024,1);
    expect(()=>counter.push(bytes)).toThrow('Invalid PostgreSQL frame');
});
