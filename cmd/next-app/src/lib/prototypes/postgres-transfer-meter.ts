/** Local test instrumentation only; never persists packets or SQL text. */
import { createConnection,createServer,type Server,type Socket } from 'node:net';
import { mkdirSync,statSync,rmdirSync } from 'node:fs';
import { join } from 'node:path';

export interface TransferMetrics {bytes:number;rows:number;requests:number;selectRequests:number}
export class ProtocolCounter {
    readonly metrics:TransferMetrics={bytes:0,rows:0,requests:0,selectRequests:0};
    private pending=Buffer.alloc(0);
    private startup:boolean;
    constructor(private readonly direction:'frontend'|'backend') {this.startup=direction==='frontend';}
    push(bytes:Buffer):void {
        this.metrics.bytes+=bytes.length;this.pending=Buffer.concat([this.pending,bytes]);
        while(this.pending.length>=(this.startup?4:5)) {
            const size=this.startup ? this.pending.readUInt32BE(0) : this.pending.readUInt32BE(1)+1;
            if(size<(this.startup?8:5)||size>16*1024*1024) throw new Error('Invalid PostgreSQL frame');
            if(this.pending.length<size) return;
            const message=this.pending.subarray(0,size);this.pending=this.pending.subarray(size);
            if(this.startup) {this.startup=false;continue;}
            const tag=String.fromCharCode(message[0]);
            if(this.direction==='backend' && tag==='D') this.metrics.rows++;
            if(this.direction==='frontend' && (tag==='Q'||tag==='P')) {
                this.metrics.requests++;
                const offset=tag==='Q'?5:message.indexOf(0,5)+1;
                const end=message.indexOf(0,offset);
                if(offset>=5 && end>=offset && /^\s*(SELECT|WITH)\b/i.test(message.subarray(offset,end).toString())) this.metrics.selectRequests++;
            }
        }
    }
}

export class PostgresTransferMeter {
    readonly host:string;
    private readonly server:Server;
    private readonly sockets=new Set<Socket>();
    private bytes=0;private rows=0;private requests=0;private selectRequests=0;
    private measuring=false;private failure:Error|undefined;
    constructor(private readonly upstream:string) {
        if(!/^\/private\/tmp\/compact-energy-pg-[A-Za-z0-9-]+$/.test(upstream)||(statSync(upstream).mode&0o777)!==0o700) throw new Error('Meter requires a private local database socket');
        this.host=join(upstream,'meter');mkdirSync(this.host,{mode:0o700});
        this.server=createServer(downstream=>{
            const backend=createConnection({path:join(upstream,'.s.PGSQL.55439')});
            this.sockets.add(downstream);this.sockets.add(backend);
            const frontendCounter=new ProtocolCounter('frontend');const backendCounter=new ProtocolCounter('backend');
            const failed=(error:Error)=>{this.failure=error;downstream.destroy();backend.destroy();};
            downstream.on('error',failed);backend.on('error',failed);
            downstream.on('close',()=>{this.sockets.delete(downstream);backend.destroy();});
            backend.on('close',()=>{this.sockets.delete(backend);downstream.destroy();});
            downstream.on('data',(data:Buffer)=>{
                const previous={...frontendCounter.metrics};
                try {frontendCounter.push(data);} catch {failed(new Error('Invalid frontend protocol'));return;}
                this.requests+=frontendCounter.metrics.requests-previous.requests;
                this.selectRequests+=frontendCounter.metrics.selectRequests-previous.selectRequests;
            });
            backend.on('data',(data:Buffer)=>{
                const previous=backendCounter.metrics.rows;
                try {backendCounter.push(data);} catch {failed(new Error('Invalid backend protocol'));return;}
                this.bytes+=data.length;this.rows+=backendCounter.metrics.rows-previous;
            });
            downstream.pipe(backend);backend.pipe(downstream);
        });
    }
    async start():Promise<void> {
        await new Promise<void>((resolve,reject)=>{
            this.server.once('error',reject);
            this.server.listen(join(this.host,'.s.PGSQL.55439'),()=>{this.server.removeListener('error',reject);resolve();});
        });
    }
    /** Serialize operations and warm up the pool before measuring (startup excluded). */
    async measure<T>(operation:()=>Promise<T>):Promise<{value:T;transfer:TransferMetrics}> {
        if(this.measuring) throw new Error('Transfer measurements must be serialized');
        this.measuring=true;
        const before={bytes:this.bytes,rows:this.rows,requests:this.requests,selectRequests:this.selectRequests};
        try {
            const value=await operation();
            if(this.failure) throw new Error('Local transfer proxy failed');
            return {value,transfer:{bytes:this.bytes-before.bytes,rows:this.rows-before.rows,requests:this.requests-before.requests,selectRequests:this.selectRequests-before.selectRequests}};
        } finally {this.measuring=false;}
    }
    async close():Promise<void> {
        for(const socket of this.sockets) socket.destroy();
        if(this.server.listening) await new Promise<void>((resolve,reject)=>this.server.close(error=>error?reject(error):resolve()));
        rmdirSync(this.host);
    }
}
