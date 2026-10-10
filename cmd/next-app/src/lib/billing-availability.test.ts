import {expect,it} from 'vitest';
import {IncompleteTariffAttributionError,readBillingAvailability} from './billing-availability';
it('returns an explicit missing-pricing state without a partial bill',async()=>{
    const result=await readBillingAvailability(async()=>{throw new IncompleteTariffAttributionError();},[]);
    expect(result).toEqual({status:'incomplete-attribution',value:[]});
});
it('never converts corruption or other database failures into missing pricing',async()=>{
    await expect(readBillingAvailability(async()=>{throw new Error('Day metadata mismatch');},[])).rejects.toThrow('Day metadata mismatch');
});
it('preserves today usage when only historical cycle pricing is incomplete',async()=>{
    const {readLiveBillingAvailability}=await import('./billing-availability');
    const today=[{energy:10}];
    expect(await readLiveBillingAvailability(async()=>{throw new IncompleteTariffAttributionError();},async()=>today))
        .toEqual({cycle:[],today,cycleStatus:'incomplete-attribution',todayStatus:'complete'});
});
