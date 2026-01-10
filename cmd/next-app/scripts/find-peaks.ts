
import fs from 'fs';
import path from 'path';

const fixturePath = path.resolve(__dirname, '../src/lib/nilm/fixtures/week-data.json');
const rawData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

let maxLoad = 0;
let maxLoadTime = '';
let countOver5k = 0;

rawData.forEach((d: any) => {
    if (d.load_power > maxLoad) {
        maxLoad = d.load_power;
        maxLoadTime = d.timestamp;
    }
    if (d.load_power > 5000) {
        countOver5k++;
        // Print the first few to see when they represent
        if (countOver5k <= 5) {
            console.log(`> 5kW Found: ${d.timestamp} = ${d.load_power}W`);
        }
    }
});

console.log(`\nGlobal Max Load: ${maxLoad}W at ${maxLoadTime}`);
console.log(`Total points > 5kW: ${countOver5k}`);

// Also check Total Power (Load + Battery Charging?)
// If Battery > 0, it's charging (based on previous analysis: Load + Batt = Grid)
let maxTotal = 0;
let maxTotalTime = '';

rawData.forEach((d: any) => {
    // Assuming Battery > 0 is Charging. 
    // Total Load = Load + (Battery > 0 ? Battery : 0)
    // Wait, verification showed: Load + Battery = Grid (when grid importing).
    // So "System Load" from Grid perspective is Grid.
    // But "House Load" is Load.
    // If Car is charging, it usually counts as "Home Load" unless separate.
    // If User says "Powerwall and Car Charging", then Powerwall Charging is Battery > 0.
    // Car Charging is inside Load.

    // Let's check "Grid Import" peaks too.
    if (d.grid_power > maxTotal) {
        maxTotal = d.grid_power;
        maxTotalTime = d.timestamp;
    }
});

console.log(`Global Max Grid Import: ${maxTotal}W at ${maxTotalTime}`);
