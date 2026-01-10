
import fs from 'fs';
import path from 'path';

const fixturePath = path.resolve(__dirname, '../src/lib/nilm/fixtures/week-data.json');
const rawData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// Target: Jan 6th, 6:30am CST = 12:30 UTC.
// Window: 12:00 UTC to 14:00 UTC.

const start = new Date('2026-01-06T12:00:00.000Z').getTime();
const end = new Date('2026-01-06T14:00:00.000Z').getTime();

console.log(`### Data Report: Jan 6th, 6:00am - 8:00am CST (12:00-14:00 UTC)`);
console.log(`| Time (CST) | Load (W) | Grid (W) | Battery (W) | Solar (W) |`);
console.log(`|---|---|---|---|---|`);

rawData.filter((d: any) => {
    const t = new Date(d.timestamp).getTime();
    return t >= start && t <= end;
}).forEach((d: any) => {
    const t = new Date(d.timestamp);
    // Rough CST conversion for display
    const cstTime = new Date(t.getTime() - 6 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(11, 19);
    console.log(`| ${cstTime} | ${d.load_power} | ${d.grid_power} | ${d.battery_power} | ${d.solar_power} |`);
});
