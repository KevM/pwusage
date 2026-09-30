#if DEBUG
import SwiftUI

enum DashboardPreviewMode: String, CaseIterable {
    case normal
    case empty
    case stale
    case modestSurplus
    case abundantSurplus
    case noFit
    case unknownBalance
    case tariffCrossing
    case longLevel1
    case noTariff
    case error
}

@MainActor
final class DashboardPreviewAPI: MobileDashboardDataAPI {
    let mode: DashboardPreviewMode
    private let liveResponse: MobileLiveResponse
    private let billResponse: MobileBillResponse

    init(mode: DashboardPreviewMode) {
        self.mode = mode
        // The stale mode is 2h01m old rather than exactly 2h: a charge reading is suppressed only
        // once it is *older* than two hours, and fixture construction and decoding happen at
        // slightly different instants, so the exact edge would be decided by clock jitter.
        let sourceOffset: TimeInterval = mode == .stale ? -(2 * 60 * 60 + 60) : 0
        let previewNow = Date.now
        // Production serializes both the energy observation time and the tariff
        // timeline with fractional seconds, and starts the timeline at the
        // observation time. Match that exactly: if the timeline begins even a
        // fraction of a second later, the estimator's shared horizon collapses to
        // the source instant and the forecast silently never becomes available.
        let instantFormatter = ISO8601DateFormatter()
        instantFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let balanceSource = previewNow.addingTimeInterval(sourceOffset)
        let sourceTime = instantFormatter.string(from: balanceSource)
        let calculatedTime = instantFormatter.string(from: previewNow)
        let calendar = Calendar.current
        let cycleStart = calendar.dateInterval(of: .month, for: previewNow)?.start ?? previewNow.addingTimeInterval(-14 * 86400)
        let cycleEnd = calendar.date(byAdding: .month, value: 1, to: cycleStart) ?? previewNow.addingTimeInterval(14 * 86400)
        let billDateFormatter = ISO8601DateFormatter()
        let cycleStartText = billDateFormatter.string(from: cycleStart)
        let cycleEndText = billDateFormatter.string(from: cycleEnd)
        let hasData = mode != .empty
        let hasTariff = mode != .noTariff
        let peakBalance: Double = switch mode {
        case .modestSurplus: 2.5
        // Peak is a net buyer and Off peak a net seller. That gives the tiles a
        // real 48c-vs-12c difference instead of two identical sell rates, and it
        // leaves the basic layer with no suggestion — the case where the solar
        // forecast belongs on the explorer card rather than the recommendation.
        case .normal: -4.2
        case .abundantSurplus: 120
        case .stale: 20
        case .noFit: -12
        case .unknownBalance: -4.2
        default: -4.2
        }
        let offPeakBalance: Double = switch mode {
        case .modestSurplus: 1.5
        case .abundantSurplus: 120
        case .noFit: -12
        case .unknownBalance: 32.4
        default: 32.4
        }
        let timelineFormatter = instantFormatter
        let tariffTimelineJSON = (0..<28).map { index in
            let interval: TimeInterval = mode == .tariffCrossing ? 60 * 60 : 6 * 60 * 60
            // Start the timeline at the balance source instant, as production does.
            let start = balanceSource.addingTimeInterval(TimeInterval(index) * interval)
            let end = previewNow.addingTimeInterval(TimeInterval(index + 1) * interval)
            let name = mode == .tariffCrossing ? (index.isMultiple(of: 2) ? "Peak" : "Off peak") : (index.isMultiple(of: 4) ? "Peak" : "Off peak")
            let buyRate = name == "Peak" ? 0.48 : 0.22
            let sellRate = 0.12
            return #"{"start":"\#(timelineFormatter.string(from: start))","end":"\#(timelineFormatter.string(from: end))","periodKey":"\#(name)","name":"\#(name)","buyRate":\#(buyRate),"sellRate":\#(sellRate)}"#
        }.joined(separator: ",")
        let activeLoadTiming = !hasTariff
            ? "null"
            : hasData
            ? #"{"periodName":"Peak","buyRate":0.48,"sellRate":0.12,"marginalCost":\#(peakBalance > 0 ? "0.12" : "0.48"),"basis":\#(peakBalance > 0 ? #""sell""# : #""buy""#),"balanceKwh":\#(peakBalance),"energyDataThrough":"\#(sourceTime)"}"#
            : #"{"periodName":"Peak","buyRate":0.48,"sellRate":0.12,"marginalCost":null,"basis":"unobserved","balanceKwh":null,"energyDataThrough":null}"#
        let tariffJSON = hasTariff ? #""Residential · Time of use""# : #""Unknown""#
        // `stateOfChargeAt` shares the live reading's source instant on purpose: decoding treats an
        // undated charge as unknown (§5.4), so a fixture that omits the key would render `--` for
        // the wrong reason. Every mode reports a charge of 72. The stale mode deliberately reports
        // one anyway, against a source two hours and a minute old, so the `--` it shows is caused
        // by the client-side freshness rule rather than by the fixture withholding the value.
        let liveJSON = #"{"version":1,"site":{"id":"preview-home","name":"Cedar House","timezone":"America/Chicago","localDate":"2026-09-23"},"live":{"solarPower":4180,"loadPower":1260,"batteryPower":-2920,"gridPower":0},"stateOfCharge":72,"activeTariff":\#(tariffJSON),"activeLoadTiming":\#(activeLoadTiming),"today":{"homeKwh":18.4,"solarKwh":14.8,"gridNetKwh":3.6,"batteryNetKwh":-2.1},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"\#(sourceTime)","energyDataThrough":\#(hasData ? #""\#(sourceTime)""# : "null"),"stateOfChargeAt":"\#(sourceTime)"}}"#
        let observedPeriods: String
        if !hasData {
            observedPeriods = "[]"
        } else if mode == .unknownBalance {
            observedPeriods = #"[{"name":"Off peak","marginalCost":0.12,"basis":"sell","cycleNetExportKwh":\#(offPeakBalance),"isActive":false,"nextStartPhrase":"tomorrow at 12:00 AM","buyRate":0.22,"sellRate":0.12}]"#
        } else {
            observedPeriods = #"[{"name":"Peak","marginalCost":\#(peakBalance > 0 ? "0.12" : "0.48"),"basis":\#(peakBalance > 0 ? #""sell""# : #""buy""#),"cycleNetExportKwh":\#(peakBalance),"isActive":true,"nextStartPhrase":"in 3 hours","buyRate":0.48,"sellRate":0.12},{"name":"Off peak","marginalCost":0.12,"basis":"sell","cycleNetExportKwh":\#(offPeakBalance),"isActive":false,"nextStartPhrase":"tomorrow at 12:00 AM","buyRate":0.22,"sellRate":0.12}]"#
        }
        let loadTimingJSON = #"{"hasTariff":true,"hasCycleData":\#(hasData ? "true" : "false"),"activeIsCheapest":false,"periods":\#(observedPeriods),"pricingPeriods":[{"name":"Off peak","marginalCost":\#(hasData ? "0.12" : "null"),"basis":\#(hasData ? #""sell""# : #""unobserved""#),"cycleNetExportKwh":\#(hasData ? String(offPeakBalance) : "0"),"isActive":false,"nextStartPhrase":"tomorrow at 12:00 AM","buyRate":0.22,"sellRate":0.12},{"name":"Peak","marginalCost":\#(hasData ? (peakBalance > 0 ? "0.12" : "0.48") : "null"),"basis":\#(hasData ? (peakBalance > 0 ? #""sell""# : #""buy""#) : #""unobserved""#),"cycleNetExportKwh":\#(hasData ? String(peakBalance) : "0"),"isActive":true,"nextStartPhrase":"in 3 hours","buyRate":0.48,"sellRate":0.12},{"name":"Shoulder","marginalCost":null,"basis":"unobserved","cycleNetExportKwh":0,"isActive":false,"nextStartPhrase":"tomorrow at 10:00 PM","buyRate":0.30,"sellRate":0.08}],"tariffTimeline":[\#(tariffTimelineJSON)],"nextCheaper":\#(hasData ? #"{"name":"Off peak","marginalCost":0.12,"phrase":"in 3 hours"}"# : "null"),"nextCheaperPhrase":\#(hasData ? #""Wait until Off peak in 3 hours""# : "null"),"nextStartPhraseByKey":{"Peak":"in 3 hours","Off peak":"tomorrow at 12:00 AM","Shoulder":"tomorrow at 10:00 PM"}}"#
        let billJSON = #"{"version":1,"site":{"id":"preview-home","name":"Cedar House","timezone":"America/Chicago"},"currentBill":{"estimatedCost":146.82,"currency":"USD","cycleStart":"\#(cycleStartText)","cycleEnd":"\#(cycleEndText)","periods":[{"tariffName":"Residential · Time of use","periodName":"Off peak","netGridKwh":214.6,"cost":26.83},{"tariffName":"Residential · Time of use","periodName":"Peak","netGridKwh":142.8,"cost":87.75},{"tariffName":"Residential · Time of use","periodName":"Solar credit","netGridKwh":-94.2,"cost":-8.72}]},"loadTiming":\#(hasTariff ? loadTimingJSON : "null"),"sources":{"calculatedAt":"\#(calculatedTime)","energyDataThrough":"\#(sourceTime)"}}"#
        liveResponse = try! MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(liveJSON.utf8))
        billResponse = try! MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(billJSON.utf8))
    }

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        if mode == .error { throw URLError(.notConnectedToInternet) }
        return liveResponse
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        if mode == .error { throw PWUsageAPIError.recoverableServerError(statusCode: 503) }
        return billResponse
    }
}

@MainActor
private struct DashboardPreview: View {
    @StateObject private var coordinator: DashboardCoordinator
    private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

    init(mode: DashboardPreviewMode) {
        let api = DashboardPreviewAPI(mode: mode)
        _coordinator = StateObject(wrappedValue: DashboardCoordinator(siteID: "preview-home", api: api, timerInterval: nil))
    }

    var body: some View {
        DashboardView(coordinator: coordinator, site: site, onChooseSite: {}, onSignOut: {})
            .task {
                coordinator.scenePhaseChanged(isActive: true)
                await coordinator.refreshDue()
            }
    }
}

@MainActor
private struct BillPreview: View {
    @StateObject private var coordinator: DashboardCoordinator
    private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

    init() {
        let api = DashboardPreviewAPI(mode: .normal)
        _coordinator = StateObject(wrappedValue: DashboardCoordinator(siteID: "preview-home", api: api, timerInterval: nil))
    }

    var body: some View {
        NavigationStack {
            BillView(coordinator: coordinator, site: site)
        }
        .task {
            coordinator.scenePhaseChanged(isActive: true)
            await coordinator.refreshDue()
        }
    }
}

@MainActor
private struct LoadTimingPreview: View {
    @StateObject private var coordinator: DashboardCoordinator
    private let profileStore: LoadProfileStore
    private let exploredProfileID: String?
    private let site = MobileSite(id: "preview-home", name: "Cedar House", utility: "Demo utility")

    init(mode: DashboardPreviewMode, exploredProfileID: String? = nil) {
        let api = DashboardPreviewAPI(mode: mode)
        _coordinator = StateObject(wrappedValue: DashboardCoordinator(siteID: "preview-home", api: api, timerInterval: nil))
        let suiteName = "pwusage.preview.load-timing.\(mode.rawValue)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        let store = LoadProfileStore(userDefaults: defaults)
        if mode == .longLevel1 {
            _ = try? store.editProfile(id: "car", energyKwh: 36, durationHours: 24, carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 80, chargingLevel: .level1))
        }
        profileStore = store
        self.exploredProfileID = exploredProfileID
    }

    var body: some View {
        NavigationStack {
            LoadTimingView(coordinator: coordinator, site: site, profileStore: profileStore, initialExploredProfileID: exploredProfileID)
        }
        .task {
            coordinator.scenePhaseChanged(isActive: true)
            await coordinator.refreshDue()
        }
    }
}

#Preview("Dashboard · Normal") {
    DashboardPreview(mode: .normal)
}

#Preview("Dashboard · No energy") {
    DashboardPreview(mode: .empty)
}

#Preview("Dashboard · Stale source") {
    DashboardPreview(mode: .stale)
}

#Preview("Dashboard · Accessibility text") {
    DashboardPreview(mode: .normal)
        .environment(\.dynamicTypeSize, .accessibility2)
}

#Preview("Dashboard · Unavailable") {
    DashboardPreview(mode: .error)
}

#Preview("Sign in") {
    SignInView(isWorking: false, message: nil, onSignIn: {})
}

#Preview("Current bill") {
    BillPreview()
}

#Preview("Load timing · Normal") {
    LoadTimingPreview(mode: .normal)
}

#Preview("Load timing · No cycle data") {
    LoadTimingPreview(mode: .empty)
}

#Preview("Load timing · Stale source") {
    LoadTimingPreview(mode: .stale)
}

#Preview("Load timing · Modest surplus") {
    LoadTimingPreview(mode: .modestSurplus)
}

#Preview("Load timing · Abundant surplus") {
    LoadTimingPreview(mode: .abundantSurplus)
}

#Preview("Load timing · Alternative estimate") {
    LoadTimingPreview(mode: .abundantSurplus, exploredProfileID: "washer")
}

#Preview("Load timing · No fit") {
    LoadTimingPreview(mode: .noFit)
}

#Preview("Load timing · Unknown balance") {
    LoadTimingPreview(mode: .unknownBalance)
}

#Preview("Load timing · Tariff crossing") {
    LoadTimingPreview(mode: .tariffCrossing)
}

#Preview("Load timing · Long Level 1") {
    LoadTimingPreview(mode: .longLevel1)
}

#Preview("Load timing · Accessibility text") {
    LoadTimingPreview(mode: .normal)
        .environment(\.dynamicTypeSize, .accessibility2)
}

#Preview("Load timing · No tariff") {
    LoadTimingPreview(mode: .noTariff)
}
#endif
