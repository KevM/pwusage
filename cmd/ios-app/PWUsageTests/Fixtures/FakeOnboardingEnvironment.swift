import Foundation
@testable import PWUsage

@MainActor
final class FakeOnboardingEnvironment: SiteHistoryOnboardingEnvironment {
    enum Answer {
        case fill(MobileSolarHistoryFill.Status)
        case disabled
        case failure(any Error)
    }

    var timeZone: TimeZone? = TimeZone(identifier: "America/Chicago")
    var historyStart = "2020-01-01"
    var answers: [Answer] = []
    var defaultAnswer: Answer = .fill(.complete)
    var requests: [(from: String, days: Int)] = []
    var sites: [String] = []
    /// Each returned day's readings; days before `firstDataDay` come back empty.
    var solarWh: [Double?] = []
    var firstDataDay = ""
    /// Holds each fill open this long (cancellable), as a slow server import would.
    var fillDelay: Duration?
    var stored: [[String]] = []
    var location = true
    /// The stored layout's confidence when the forecast can use it.
    var confidence: SolarLayoutConfidence?
    /// Stored days produce, and every `clearEvery`th of them is clear (0: none). Only the newest
    /// `producingDayLimit` stored days produce.
    var producing = true
    var clearEvery = 0
    var producingDayLimit = Int.max
    var passes: [SolarDayClassification] = []
    var detections: [DetectedSolarLayout] = []
    var detectionCount = 0
    var onFill: (() -> Void)?
    var onFillWait: (() async -> Void)?
    /// Passes that come back empty, as one cut off by a background expiry would.
    var lostPasses = 0
    /// Runs when detection starts, before it answers.
    var onDetect: (() async -> Void)?
    var onClassify: (() async -> Void)?

    func fill(siteID: String, from: String, days: Int) async throws -> MobileSolarHistoryFillResponse {
        requests.append((from, days))
        sites.append(siteID)
        onFill?()
        await onFillWait?()
        if let fillDelay { try await Task.sleep(for: fillDelay) }
        let answer = answers.isEmpty ? defaultAnswer : answers.removeFirst()
        switch answer {
        case .disabled: return .disabled
        case .failure(let error): throw error
        case .fill(let status):
            let zone = timeZone ?? .gmt
            let list = (0 ..< days).compactMap { SiteLocalDays.adding($0, to: from, timeZone: zone) }
            return .enabled(MobileSolarHistoryFill(
                timeZone: zone, status: status, historyStart: historyStart,
                days: list.map { day in
                    MobileSolarHistoryDay(
                        day: day, dayStart: .distantPast, status: .complete, fetchedAt: nil,
                        solarWh: day >= firstDataDay ? solarWh : [])
                }))
        }
    }

    func storeDays(_ fill: MobileSolarHistoryFill, scope _: SolarForecastSiteScope) async throws {
        stored.append(fill.days.map(\.day))
    }

    func siteTimeZone(scope _: SolarForecastSiteScope) async -> TimeZone? { timeZone }
    func hasLocation(scope _: SolarForecastSiteScope) async -> Bool { location }
    func layoutConfidence(scope _: SolarForecastSiteScope) async -> SolarLayoutConfidence? { confidence }

    /// The stored result the status shows; days come from `stored`.
    var storedResult: DetectedSolarLayout?
    var isRevealOwed = false

    func storedState(scope _: SolarForecastSiteScope) async -> SiteHistoryStoredState {
        SiteHistoryStoredState(
            result: storedResult,
            location: location ? SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .device) : nil,
            days: Array(Set(stored.flatMap(\.self))).sorted(),
            isRevealOwed: isRevealOwed)
    }

    func acknowledgeReveal(scope _: SolarForecastSiteScope) async { isRevealOwed = false }

    func classifyDays(scope _: SolarForecastSiteScope) async -> SolarDayClassification? {
        await onClassify?()
        guard location else { return nil }
        if lostPasses > 0 {
            lostPasses -= 1
            return nil
        }
        let days = stored.flatMap(\.self).sorted(by: >)
        var types: [String: SolarDayType] = [:]
        for (index, day) in days.enumerated() {
            if !producing || index >= producingDayLimit {
                types[day] = .noProduction
            } else {
                types[day] = clearEvery > 0 && index % clearEvery == 0 ? .clear : .cloudy
            }
        }
        let pass = SolarDayClassification(days: types)
        passes.append(pass)
        return pass
    }

    func detect(scope _: SolarForecastSiteScope) async -> DetectedSolarLayout? {
        detectionCount += 1
        await onDetect?()
        return detections.isEmpty ? nil : detections.removeFirst()
    }
}
