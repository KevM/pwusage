export class IncompleteTariffAttributionError extends Error {
    constructor() {super('Incomplete tariff attribution');this.name='IncompleteTariffAttributionError';}
}
export async function readBillingAvailability<T>(read:()=>Promise<T>,unavailable:T):Promise<{status:'complete'|'incomplete-attribution';value:T}> {
    try {return {status:'complete',value:await read()};}
    catch(error) {
        if(error instanceof IncompleteTariffAttributionError)return {status:'incomplete-attribution',value:unavailable};
        throw error;
    }
}

/** Old missing pricing must not erase today's independently available usage. */
export async function readLiveBillingAvailability<T>(
    read:()=>Promise<{cycle:T[];today:T[]}>,readToday:()=>Promise<T[]>
) {
    const billing=await readBillingAvailability(read,{cycle:[],today:[]});
    const today=billing.status==='complete'
        ? {status:'complete' as const,value:billing.value.today}
        : await readBillingAvailability(readToday,[]);
    return {cycle:billing.value.cycle,today:today.value,cycleStatus:billing.status,todayStatus:today.status};
}
