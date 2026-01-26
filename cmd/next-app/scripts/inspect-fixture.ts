
import fs from 'fs';
import path from 'path';

const fixturePath = path.resolve(__dirname, '../src/lib/nilm/fixtures/week-data.json');
const rawData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// User Local Time: -06:00 (CST/MDT?)
// Event 1: Jan 6th 6:30am -> 12:30 UTC
// Event 2: Jan 5th 5:30am -> 11:30 UTC

const targetTimes = [
    { label: 'Jan 5th 5:30am Local', utcStart: '2026-01-05T11:00:00.000Z', utcEnd: '2026-01-05T14:30:00.000Z' }, // Window around 5:30am-8am
    { label: 'Jan 6th 6:30am Local', utcStart: '2026-01-06T12:00:00.000Z', utcEnd: '2026-01-06T14:30:00.000Z' }  // Window around 6:30am-8am
];

targetTimes.forEach(target => {
    console.log(`\n--- Inspecting ${target.label} ---`);
    const start = new Date(target.utcStart).getTime();
    const end = new Date(target.utcEnd).getTime();

    const points = rawData.filter((d: any) => {
        const t = new Date(d.timestamp).getTime();
        return t >= start && t <= end;
    });

    if (points.length === 0) {
        console.log('No data points found in this window.');
    } else {
        // Print header
        console.log(`Timestamp (UTC)      | Load | Solar | Grid | Battery`);
        points.forEach((p: any) => {
            console.log(`${p.timestamp} | ${p.load_power} | ${p.solar_power} | ${p.grid_power} | ${p.battery_power}`);
        });

        const maxLoad = Math.max(...points.map((p: any) => p.load_power));
        console.log(`Max Load in window: ${maxLoad}`);
    }
});
