import { describe, expect, it } from 'vitest';
import { modelKw } from './poa';
import { syntheticSeries } from './synthetic';
import { detectClip, envelopeClear, learnShade, toSeries, type Series } from './selection';

const base = {
    latitude: 35, longitude: -118, timeZone: 'America/Los_Angeles', start: '2026-03-01', days: 120,
    planes: [{ azimuth: 180, tilt: 25, effectiveKw: 6 }], cloudyFraction: 0.4, seed: 1,
};

function seriesOf(opts: Parameters<typeof syntheticSeries>[0]): Series {
    return toSeries(syntheticSeries(opts), opts.latitude, opts.longitude, opts.timeZone);
}

function peakOf(series: Series): number {
    const vals = series.filter(s => s.sun.elevation > 10 && Number.isFinite(s.kw)).map(s => s.kw).sort((a, b) => a - b);
    return vals[Math.floor(0.999 * (vals.length - 1))];
}

describe('envelopeClear', () => {
    it('selects clear-day daylight and rejects cloudy days', () => {
        const series = seriesOf(base);
        const clear = seriesOf({ ...base, cloudyFraction: 0 });
        const clearDays = new Set<string>();
        const byDay = new Map<string, boolean>();
        // A clear day is within the generator's 0.94-1.0 clear-day level of the all-clear series.
        series.forEach((s, i) => byDay.set(s.localDay, (byDay.get(s.localDay) ?? true) && Math.abs(s.kw - clear[i].kw) <= 0.07 * Math.max(clear[i].kw, 0.01)));
        for (const [day, same] of byDay) if (same) clearDays.add(day);
        expect(clearDays.size).toBeGreaterThan(50);
        expect(clearDays.size).toBeLessThan(90);

        const mask = envelopeClear(series, peakOf(series));
        let clearTotal = 0, clearHit = 0, cloudyTotal = 0, cloudyHit = 0;
        series.forEach((s, i) => {
            if (s.sun.elevation <= 10) return;
            if (clearDays.has(s.localDay)) { clearTotal++; if (mask[i]) clearHit++; }
            else { cloudyTotal++; if (mask[i]) cloudyHit++; }
        });
        expect(clearHit / clearTotal).toBeGreaterThanOrEqual(0.85);
        expect(cloudyHit / cloudyTotal).toBeLessThanOrEqual(0.05);
    });
});

describe('detectClip', () => {
    it('finds an AC clip plateau', () => {
        const found = detectClip(seriesOf({ ...base, clipKw: 4.5 }));
        expect(found).not.toBeNull();
        expect(Math.abs(found!.limitKw - 4.5) / 4.5).toBeLessThanOrEqual(0.02);
        expect(found!.days).toBeGreaterThanOrEqual(5);
    });

    it('reports no clip for an unclipped system', () => {
        expect(detectClip(seriesOf(base))).toBeNull();
    });
});

describe('learnShade', () => {
    it('learns a low western obstruction', () => {
        const shade = { azimuthFrom: 240, azimuthTo: 290, belowElevation: 20 };
        const series = seriesOf({ ...base, shade: [shade] });
        const clear = envelopeClear(series, peakOf(series));
        const saz: number[] = [], el: number[] = [], ratio: number[] = [], days: string[] = [];
        series.forEach((s, i) => {
            if (s.sun.elevation <= 3) return;
            const m = modelKw(s.sun, base.planes, null);
            saz.push(s.sun.azimuth); el.push(s.sun.elevation); days.push(s.localDay);
            ratio.push(clear[i] || (s.sun.azimuth >= 240 && s.sun.azimuth < 290) ? (m > 0.02 * 6 ? s.kw / m : NaN) : NaN);
        });
        const mask = learnShade(saz, el, ratio, days);
        expect(mask.shaded(260, 10)).toBe(true);
        expect(mask.shaded(180, 10)).toBe(false);
        expect(mask.shaded(260, 40)).toBe(false);
    });
});

describe('toSeries', () => {
    it('groups by local day across DST changes', () => {
        const fall = seriesOf({ ...base, start: '2026-10-31', days: 3, cloudyFraction: 0 });
        expect(fall.filter(s => s.localDay === '2026-11-01')).toHaveLength(300);
        expect(fall.filter(s => s.localDay === '2026-10-31')).toHaveLength(288);
        const spring = seriesOf({ ...base, start: '2026-03-07', days: 3, cloudyFraction: 0 });
        expect(spring.filter(s => s.localDay === '2026-03-08')).toHaveLength(276);
        expect(new Set(spring.map(s => s.localDay))).toEqual(new Set(['2026-03-07', '2026-03-08', '2026-03-09']));
    });

    it('snaps off-grid timestamps to the five-minute grid instead of shifting it', () => {
        const samples = syntheticSeries({ ...base, start: '2026-05-01', days: 3, cloudyFraction: 0 });
        const shifted = samples.map((s, i) => ({ ...s, timestamp: new Date(s.timestamp.getTime() + (i === 0 ? 123 : i === 5 ? -40_000 : 0)) }));
        const series = toSeries(shifted, base.latitude, base.longitude, base.timeZone);
        expect(series).toHaveLength(samples.length);
        expect(series[0].time.toISOString()).toBe('2026-05-01T07:00:00.000Z');
        expect(series.filter(p => Number.isNaN(p.kw))).toHaveLength(0);
        expect(Math.max(...series.map(p => p.kw))).toBeGreaterThan(5);
    });

    it('converts Wh per 5 minutes to kW, fills gaps with NaN and removes a night baseline', () => {
        const t0 = Date.parse('2026-06-01T07:00:00Z');
        const samples = [0, 1, 3].map(i => ({ timestamp: new Date(t0 + i * 300_000), solarWh: 2 }));
        const s = toSeries(samples, 35, -118, 'America/Los_Angeles');
        expect(s).toHaveLength(4);
        expect(Number.isNaN(s[2].kw)).toBe(true);
        // All samples are night: the 0.024 kW baseline is removed.
        expect(s[0].kw).toBe(0);
    });
});
