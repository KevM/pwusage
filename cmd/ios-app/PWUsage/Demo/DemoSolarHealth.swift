import Foundation

/// Synthetic multi-year solar health data for Demo Mode, including active soiling,
/// summer morning shading, and 3 years of aging so all House View visuals can be explored.
enum DemoSolarHealth {
    static let manualLayout = ManualSolarLayout(systems: [
        ManualSolarSystem(
            label: "Sample Roof",
            installDate: Date(timeIntervalSince1970: 1_688_169_600), // 2023-07-01
            inverterAcKw: 7.6,
            faces: [
                ManualSolarFace(
                    label: "East", panelCount: 10, panelWatts: 400, azimuthDegrees: 90, tiltDegrees: 20),
                ManualSolarFace(
                    label: "West", panelCount: 10, panelWatts: 400, azimuthDegrees: 270, tiltDegrees: 20)
            ])
    ])

    @MainActor
    static func makeModel(
        records: SolarLayoutRecordStore,
        defaults: UserDefaults,
        folder: URL
    ) -> SolarHealthModel {
        let history = SolarHistoryStore(directory: folder.appendingPathComponent("SolarHealthHistory"))
        let cache = SolarHealthCache(directory: folder.appendingPathComponent("SolarHealthCache"))
        return SolarHealthModel(
            history: history,
            records: records,
            cache: cache,
            defaults: defaults,
            runner: { _, _, record, _, _ in
                makeResult(record: record)
            })
    }

    static func makeResult(record: SolarLayoutRecord) -> SolarHealthResult? {
        guard let reference = SolarHealthReference(manual: record.manualLayout, detected: record.result) else {
            return nil
        }
        let summerShade = SolarSeasonShade(
            season: .summer,
            map: SolarShadeMap(makeEastMorningShadeMask()),
            clearDays: 28)

        let y2024 = makeYear(
            year: 2024, site: 1.00, directions: (1.00, 1.00), shade: [summerShade], ratios: [])
        let y2025 = makeYear(
            year: 2025, site: 0.96, directions: (0.95, 0.97), shade: [summerShade], ratios: [])
        let y2026 = makeYear(
            year: 2026, site: 0.91, directions: (0.90, 0.92),
            shade: [summerShade], ratios: makeActiveSoilingRatios())

        return SolarHealthResult(
            reference: reference,
            years: [y2024, y2025, y2026],
            referenceScale: 1.0,
            recomputedYears: [2026])
    }

    private static func makeYear(
        year: Int, site: Double, directions: (east: Double, west: Double),
        shade: [SolarSeasonShade], ratios: [SolarDailyRatio]
    ) -> SolarHealthYear {
        let capacity = SolarHealthCapacity(
            site: site,
            directions: [.init(azimuth: 90, factor: directions.east), .init(azimuth: 270, factor: directions.west)],
            clearDays: 45)
        let months = (1 ... 12).map { month in
            SolarHealthMonth(month: month, capacity: capacity)
        }
        return SolarHealthYear(
            year: year, key: "demo-\(year)", clearDays: 45,
            capacity: capacity, months: months, shade: shade, dailyRatios: ratios)
    }

    private static func makeEastMorningShadeMask() -> ShadeMask {
        var horizon = Array(repeating: -Double.infinity, count: 36)
        for bin in 6 ... 10 {
            horizon[bin] = 32
        }
        return ShadeMask(horizon: horizon, hotBins: [])
    }

    /// Spring soiling recovery followed by an active dry spell (~9% current loss).
    private static func makeActiveSoilingRatios() -> [SolarDailyRatio] {
        let points: [(day: String, ratio: Double)] = [
            ("2026-04-01", 0.96), ("2026-04-02", 0.95), ("2026-04-03", 0.93),
            ("2026-04-04", 0.92), ("2026-04-05", 0.90), ("2026-04-08", 0.96),
            ("2026-04-12", 0.96), ("2026-04-13", 0.94), ("2026-04-14", 0.92),
            ("2026-04-15", 0.90), ("2026-04-16", 0.88), ("2026-04-17", 0.87)
        ]
        return points.map { point in
            SolarDailyRatio(
                day: point.day,
                ratio: point.ratio,
                expectedKwh: 40.0,
                actualKwh: 40.0 * point.ratio)
        }
    }
}
