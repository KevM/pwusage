#if DEBUG
import SwiftUI

private enum DashboardPreviewMode: String, CaseIterable {
    case normal
    case empty
    case stale
    case error
}

@MainActor
private final class DashboardPreviewAPI: MobileDashboardDataAPI {
    let mode: DashboardPreviewMode
    private let liveResponse: MobileLiveResponse
    private let billResponse: MobileBillResponse

    init(mode: DashboardPreviewMode) {
        self.mode = mode
        let sourceOffset: TimeInterval = mode == .stale ? -2 * 60 * 60 : 0
        let sourceTime = ISO8601DateFormatter().string(from: Date.now.addingTimeInterval(sourceOffset))
        let hasData = mode != .empty
        let liveJSON = #"{"version":1,"site":{"id":"preview-home","name":"Cedar House","timezone":"America/Chicago","localDate":"2026-09-23"},"live":{"solarPower":4180,"loadPower":1260,"batteryPower":-2920,"gridPower":0},"stateOfCharge":\#(mode == .stale ? "null" : "72"),"activeTariff":\#(hasData ? #""Residential · Time of use""# : "null"),"today":{"homeKwh":18.4,"solarKwh":14.8,"gridNetKwh":3.6,"batteryNetKwh":-2.1},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"\#(sourceTime)","energyDataThrough":\#(hasData ? #""\#(sourceTime)""# : "null")}}"#
        let billJSON = #"{"version":1,"site":{"id":"preview-home","name":"Cedar House","timezone":"America/Chicago"},"currentBill":{"estimatedCost":146.82,"currency":"USD","cycleStart":"2026-09-01T05:00:00Z","cycleEnd":"2026-10-01T05:00:00Z","periods":[{"tariffName":"Residential · Time of use","periodName":"Off peak","netGridKwh":214.6,"cost":26.83},{"tariffName":"Residential · Time of use","periodName":"Peak","netGridKwh":142.8,"cost":87.75},{"tariffName":"Residential · Time of use","periodName":"Solar credit","netGridKwh":-94.2,"cost":-8.72}]},"sources":{"calculatedAt":"\#(sourceTime)","energyDataThrough":"\#(sourceTime)"}}"#
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
#endif
