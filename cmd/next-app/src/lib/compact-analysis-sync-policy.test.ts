import {expect,it} from 'vitest';
import {shouldSyncAnalysisHistory} from './compact-analysis-sync-policy';
const today=new Date('2026-10-07T05:00:00Z');
it.each([
    [false,today,false],
    [false,new Date(+today-86400000),false],
    [true,today,true],
    [false,new Date(+today+86400000),true],
    [false,new Date(+today+2*86400000),false],
])('force=%s end=%s permits sync=%s',(force,end,expected)=>{
    expect(shouldSyncAnalysisHistory({force,start:new Date(+end-86400000),end,todayStart:today,todayEnd:new Date(+today+86400000)})).toBe(expected);
});
