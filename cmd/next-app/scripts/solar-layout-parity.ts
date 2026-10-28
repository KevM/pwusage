// Local-only parity run for the solar layout detector against the Python
// reference (scripts/solar-layout-reference/). Research data never enters the
// repo: point --dir at a folder outside it.
//
//   npx tsx scripts/solar-layout-parity.ts --dir /path/outside/repo [--site site-a]
//
// The folder holds site-*.csv files (timestamp,solar_wh; UTC interval start,
// Wh per 5 minutes) and an inputs.json of { sites: { "site-a": { timezone, lat, lon } } }.
// Writes <site>.ts.json (the SolarLayoutResult plus runtimeMs) next to each CSV.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectSolarLayout } from '../src/lib/solar-layout/detect';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg('dir');
if (!dir) {
    console.error('Usage: npx tsx scripts/solar-layout-parity.ts --dir <folder> [--site <name>]');
    process.exit(1);
}
const only = arg('site');
const inputs = JSON.parse(readFileSync(path.join(dir, 'inputs.json'), 'utf8')).sites as Record<string, { timezone: string; lat: number; lon: number }>;

for (const file of readdirSync(dir).filter(f => /^site-.*\.csv$/.test(f)).sort()) {
    const site = file.replace(/\.csv$/, '');
    if (only && site !== only) continue;
    const cfg = inputs[site];
    if (!cfg) { console.warn(`${site}: not in inputs.json, skipped`); continue; }
    const samples = readFileSync(path.join(dir, file), 'utf8').trim().split('\n').slice(1).map(line => {
        const [timestamp, wh] = line.split(',');
        return { timestamp: new Date(timestamp), solarWh: Number(wh) };
    });
    const started = Date.now();
    const result = detectSolarLayout({ samples, latitude: cfg.lat, longitude: cfg.lon, timeZone: cfg.timezone });
    const runtimeMs = Date.now() - started;
    writeFileSync(path.join(dir, `${site}.ts.json`), JSON.stringify({ ...result, runtimeMs }, null, 2));
    console.log(`${site}: ${result.status} ${result.confidence ?? '-'} planes=${result.planes.length} ${runtimeMs} ms`);
}
