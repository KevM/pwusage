import {expect,it} from 'vitest';
import {parseArchiveControlArgs} from './history-archive-control';
it('parses an explicit bounded cohort',()=>{
    expect(parseArchiveControlArgs(['trim','site','--from','2026-08-01','--before','2026-08-02'])).toEqual({action:'trim',sites:['site'],from:'2026-08-01',before:'2026-08-02'});
});
it('rejects malformed cohorts before database access',()=>{
    for(const args of [[],['unknown'],['trim'],['trim','site','--from'],['trim','site','--before'],['trim','site','--from','--before','2026-08-02'],
        ['trim','site','--from','2026-08-01'],['trim','site','--from','2026-08-01','--before','2026-07-31'],
        ['trim','site','--from','2026-08-01','--from','2026-08-01','--before','2026-08-02'],['trim','site','site'],['pause','site']]) {
        expect(()=>parseArchiveControlArgs(args)).toThrow();
    }
});
