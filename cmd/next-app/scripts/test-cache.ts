
import { EnergyRepo } from '../src/lib/energy-repo';

async function testCache() {
    const repo = new EnergyRepo();
    const siteIds = repo.getSiteIds();
    if (siteIds.length === 0) {
        console.log('No sites found to test');
        return;
    }
    const siteId = siteIds[0];

    console.log('--- 1st Call (Expect Cache Miss) ---');
    const start1 = Date.now();
    repo.getSite(siteId);
    console.log(`Time: ${Date.now() - start1}ms`);

    console.log('\n--- 2nd Call (Expect Cache Hit) ---');
    const start2 = Date.now();
    repo.getSite(siteId);
    console.log(`Time: ${Date.now() - start2}ms`);

    console.log('\n--- 3rd Call (Expect Cache Hit) ---');
    const start3 = Date.now();
    repo.getSite(siteId);
    console.log(`Time: ${Date.now() - start3}ms`);
}

testCache();
