// Mobile contract for the automatic solar forecast (GET /api/mobile/solar-layout).
// Azimuth is compass degrees (0 = N, 90 = E, 180 = S, 270 = W); the phone converts
// to Forecast.Solar's convention. A layout is served only when detection
// succeeded with high or medium confidence.
import type { SiteSolarLayoutRow, SolarLocationSource } from '@/lib/solar-layout-repo';

export type MobileSolarLayoutReason = 'needs-location' | 'pending' | 'not-enough-history' | 'low-confidence';

export type MobileSolarLayout =
    | { version: 1; enabled: false }
    | {
        version: 1;
        enabled: true;
        location: { latitude: number; longitude: number; source: SolarLocationSource } | null;
        layout: {
            planes: { azimuth: number; tilt: number; dcKwp: number }[];
            acClipKw: number | null;
            confidence: 'high' | 'medium';
            detectedAt: string | null;
        } | null;
        reason: MobileSolarLayoutReason | null;
    };

export function toMobileSolarLayout(row: SiteSolarLayoutRow | null): MobileSolarLayout {
    // A null source means the location was stored before sources existed, i.e. admin-seeded.
    const location: { latitude: number; longitude: number; source: SolarLocationSource } | null =
        row && row.latitude !== null && row.longitude !== null
            ? { latitude: row.latitude, longitude: row.longitude, source: row.locationSource ?? 'estimated' }
            : null;
    if (!row || !location) return { version: 1, enabled: true, location: null, layout: null, reason: 'needs-location' };
    const result = row.result;
    if (row.status === 'detected' && result && (result.confidence === 'high' || result.confidence === 'medium')) {
        return {
            version: 1, enabled: true, location, reason: null,
            layout: {
                planes: result.planes.map(p => ({ azimuth: p.azimuth, tilt: p.tilt, dcKwp: p.dcKwp })),
                acClipKw: result.acClipKw,
                confidence: result.confidence,
                detectedAt: row.detectedAt ? row.detectedAt.toISOString() : null,
            },
        };
    }
    const reason: MobileSolarLayoutReason = row.status === 'not-enough-history' ? 'not-enough-history'
        : row.status === 'low-confidence' ? 'low-confidence' : 'pending';
    return { version: 1, enabled: true, location, layout: null, reason };
}
