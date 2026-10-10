import {validateMaintenanceDates} from './prototypes/compact-history-maintenance';
export interface ArchiveControlArgs {action:'status'|'pause'|'archive'|'trim';sites:string[];from?:string;before?:string}
export function parseArchiveControlArgs(args:string[]):ArchiveControlArgs {
    const [action,...rest]=args;
    if(action!=='status'&&action!=='pause'&&action!=='archive'&&action!=='trim')throw new Error('Expected status, pause, archive or trim');
    if((action==='status'||action==='pause')&&rest.length)throw new Error('Status and pause take no arguments');
    const sites:string[]=[];let from:string|undefined,before:string|undefined;
    for(let i=0;i<rest.length;i++) {
        const key=rest[i];
        if(key==='--from'||key==='--before') {
            const value=rest[++i];
            if(!value||value.startsWith('--'))throw new Error('Missing cohort date');
            if(key==='--from') {if(from!==undefined)throw new Error('Duplicate from date');from=value;}
            else {if(before!==undefined)throw new Error('Duplicate before date');before=value;}
        } else {
            if(!key.trim()||key.length>200||key.startsWith('--'))throw new Error('Invalid site ID');sites.push(key);
        }
    }
    if(from!==undefined||before!==undefined)validateMaintenanceDates(from??'',before??'');
    if(action==='archive'||action==='trim') {
        if(!sites.length||sites.length>100||new Set(sites).size!==sites.length)throw new Error('Supply 1–100 distinct explicit site IDs');
    }
    return {action,sites,...(from===undefined?{}:{from,before})};
}
