import Foundation
@testable import PWUsage

/// Synthetic 5-minute production with a known problem built in. Clear days follow the app's own
/// plane-of-array model (so the truth is the layout and the factors given), cloudy days are cut down,
/// and the true array can lose capacity by month, lose it on given days, or be shaded by season.
struct SyntheticSolarSite {
    /// What the array really is: planes at effective size, as the health reference models them.
    var planes: [SolarHealthPlane]
    var latitude = 43.4
    var longitude = -87.9
    var timeZone = TimeZone(identifier: "America/Chicago") ?? .gmt
    var clipKw: Double?
    /// Production over the model for a given year and month; 1 is a healthy array.
    var capacity: (_ year: Int, _ month: Int) -> Double = { _, _ in 1 }
    /// Extra production scale for one site-local day (`yyyy-MM-dd`), for soiling and faults.
    var dayScale: (_ day: String) -> Double = { _ in 1 }
    /// True where the sun is behind an obstruction on the given day.
    var shaded: (_ day: String, _ azimuth: Double, _ elevation: Double) -> Bool = { _, _, _ in false }
    /// Every n-th day is overcast.
    var overcastEvery = 4

    /// Samples from `from` to `through` (site-local dates, inclusive), daylight hours only.
    @_optimize(speed)
    func samples(from: DateComponents, through: DateComponents) -> [(timestamp: Date, solarWh: Double)] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard var day = calendar.date(from: from), let last = calendar.date(from: through) else { return [] }
        var out: [(timestamp: Date, solarWh: Double)] = []
        var ordinal = 0
        while day <= last {
            let parts = calendar.dateComponents([.year, .month, .day], from: day)
            let name = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
            let scale = capacity(parts.year ?? 0, parts.month ?? 1) * dayScale(name)
            let overcast = ordinal % overcastEvery == overcastEvery - 1
            for slot in 48 ..< 264 {
                let time = day.addingTimeInterval(Double(slot) * 300)
                let slotContext = SlotContext(
                    time: time, day: name, scale: scale, overcast: overcast, slot: slot, ordinal: ordinal)
                let powerKw = production(at: slotContext)
                out.append((time, powerKw * 1000 / 12))
            }
            ordinal += 1
            day = calendar.date(byAdding: .day, value: 1, to: day) ?? last.addingTimeInterval(1)
        }
        return out
    }

    private struct SlotContext {
        let time: Date
        let day: String
        let scale: Double
        let overcast: Bool
        let slot: Int
        let ordinal: Int
    }

    private func production(at context: SlotContext) -> Double {
        let sun = layoutSun(at: context.time.addingTimeInterval(150), latitude: latitude, longitude: longitude)
        guard sun.ghi > 0 else { return 0 }
        var powerKw = context.scale * LayoutPOA.modelKw(sun: sun, planes: planes.map {
            LayoutPlane(azimuth: $0.azimuth, tilt: $0.tilt, effectiveKw: $0.effectiveKw)
        })
        if shaded(context.day, sun.azimuth, sun.elevation) { powerKw *= 0.3 }
        if context.overcast {
            powerKw *= 0.15 + 0.25 * abs(sin(Double(context.slot * 7 + context.ordinal * 13)))
        }
        if let clipKw { powerKw = min(powerKw, clipKw) }
        return powerKw
    }
}

extension SolarHealthPlane {
    /// A face of `powerKw` effective size.
    static func face(_ azimuth: Double, tilt: Double = 25, kw powerKw: Double = 3) -> SolarHealthPlane {
        SolarHealthPlane(azimuth: azimuth, tilt: tilt, effectiveKw: powerKw)
    }
}

/// A manual layout whose faces are `planes` at nameplate, so the health reference models them
/// at the detector's derate.
func manualLayout(for planes: [SolarHealthPlane], installDates: [Date?]? = nil) -> ManualSolarLayout {
    let systems = planes.enumerated().map { index, plane in
        ManualSolarSystem(
            installDate: installDates?[index], faces: [ManualSolarFace(
                panelCount: 10, panelWatts: plane.effectiveKw / SolarLayoutDetector.derate * 100,
                azimuthDegrees: plane.azimuth, tiltDegrees: plane.tilt)])
    }
    return ManualSolarLayout(systems: systems)
}
