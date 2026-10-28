// Test-only: synthetic 5-minute production from a known layout (clear-sky model,
// seeded cloudy days, a shade mask and clipping). Imported only by tests and
// never by runtime code. Research sites' data is never committed; CI uses this.
import { Temporal } from '@js-temporal/polyfill';
import { sunAt } from './sun';
import { modelKw, type Plane } from './poa';

export type ShadeBox = { azimuthFrom: number; azimuthTo: number; belowElevation: number };

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function syntheticSeries(opts: {
    latitude: number; longitude: number; timeZone: string; start: string; days: number;
    planes: Plane[]; clipKw?: number; cloudyFraction: number; shade?: ShadeBox[]; seed: number;
}): { timestamp: Date; solarWh: number }[] {
    const rng = mulberry32(opts.seed);
    const out: { timestamp: Date; solarWh: number }[] = [];
    const startDay = Temporal.PlainDate.from(opts.start);
    for (let d = 0; d < opts.days; d++) {
        const day = startDay.add({ days: d });
        const from = day.toZonedDateTime({ timeZone: opts.timeZone }).epochMilliseconds;
        const to = day.add({ days: 1 }).toZonedDateTime({ timeZone: opts.timeZone }).epochMilliseconds;
        const cloudy = rng() < opts.cloudyFraction;
        const level = cloudy ? 0.1 + 0.6 * rng() : 1;
        for (let t = from; t < to; t += 300_000) {
            const sun = sunAt(new Date(t + 150_000), opts.latitude, opts.longitude);
            let kw = modelKw(sun, opts.planes, null);
            if (cloudy) kw *= Math.max(0, level * (0.7 + 0.6 * rng()));
            if (opts.shade?.some(s => sun.azimuth >= s.azimuthFrom && sun.azimuth < s.azimuthTo && sun.elevation < s.belowElevation)) kw *= 0.2;
            if (opts.clipKw !== undefined) kw = Math.min(kw, opts.clipKw);
            out.push({ timestamp: new Date(t), solarWh: kw * 1000 / 12 });
        }
    }
    return out;
}
