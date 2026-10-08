import {expect,it} from 'vitest';
import {shouldSyncAnalysisHistory} from './compact-analysis-sync-policy';
const today=new Date('2026-10-07T05:00:00Z');
it.each([
    [false,false,new Date(+today-86400000),true],
    [true,false,today,false],
    [true,false,new Date(+today-86400000),false],
    [true,true,today,true],
    [true,false,new Date(+today+86400000),true],
    [true,false,new Date(+today+2*86400000),false],
])('archive=%s force=%s end=%s permits sync=%s',(archiveReads,force,end,expected)=>{
    expect(shouldSyncAnalysisHistory({archiveReads,force,start:new Date(+end-86400000),end,todayStart:today,todayEnd:new Date(+today+86400000)})).toBe(expected);
});
