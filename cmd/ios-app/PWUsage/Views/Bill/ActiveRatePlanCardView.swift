import SwiftUI

struct TariffTimelineActions: Sendable {
    var load: @MainActor () async throws -> SiteTariffsTimelineResponse
    var refreshFromTesla: @MainActor () async throws -> SiteTariffsTimelineResponse
    var createPeriod: @MainActor (TariffPlanWriteRequest) async throws -> SiteTariffsTimelineResponse
    var updatePeriod: @MainActor (Int, TariffPlanPatchRequest) async throws -> SiteTariffsTimelineResponse
    var deletePeriod: @MainActor (Int) async throws -> SiteTariffsTimelineResponse
    var retryReattribution: @MainActor () async throws -> SiteTariffsTimelineResponse
    var searchUtilities: @MainActor (String) async throws -> [String]
    var setUtility: @MainActor (String) async throws -> Void
    var skipUtility: @MainActor () async throws -> Void
    var utilityPlans: @MainActor () async throws -> [UtilityPlanDTO]
    var setUtilityPlan: @MainActor (String) async throws -> Void
    var loadRateHistory: @MainActor () async throws -> RatePlanHistoryDTO
    var saveRateHistory: @MainActor ([RatePlanHistoryPeriod]) async throws -> SiteTariffsTimelineResponse

    @MainActor static func live(_ coordinator: DashboardCoordinator) -> Self {
        Self(
            load: { try await coordinator.fetchTariffTimeline() },
            refreshFromTesla: { try await coordinator.refreshTariffsFromTesla() },
            createPeriod: { try await coordinator.createTariffPeriod($0) },
            updatePeriod: { try await coordinator.updateTariffPeriod(periodID: $0, body: $1) },
            deletePeriod: { try await coordinator.deleteTariffPeriod(periodID: $0) },
            retryReattribution: { try await coordinator.retryTariffReattribution() },
            searchUtilities: { try await coordinator.searchUtilities(query: $0) },
            setUtility: { _ = try await coordinator.setUtility(name: $0) },
            skipUtility: { _ = try await coordinator.skipUtility() },
            utilityPlans: { try await coordinator.utilityPlans() },
            setUtilityPlan: { _ = try await coordinator.setUtilityPlan(label: $0) },
            loadRateHistory: { try await coordinator.loadRateHistory() },
            saveRateHistory: { try await coordinator.saveRateHistory($0) }
        )
    }
}

enum RatePlanEditorMode: Identifiable, Equatable {
    case add
    case copy(TariffPeriodDTO)
    case edit(TariffPeriodDTO)

    var id: String {
        switch self {
        case .add: "add"
        case .copy(let period): "copy-\(period.periodId)"
        case .edit(let period): "edit-\(period.periodId)"
        }
    }

    /// Names a plan saved in this mode must not reuse. An edited plan keeps its own name, which its
    /// other date ranges (separate tariff versions) share, as the server allows. Estimated plans
    /// never reserve a name: the server ignores them when checking names.
    func takenNames(among periods: [TariffPeriodDTO]) -> [String] {
        func normalized(_ name: String) -> String {
            name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        var ownName: String?
        if case .edit(let period) = self { ownName = normalized(period.name) }
        return periods.filter { $0.source != .estimated }.map(\.name).filter { normalized($0) != ownName }
    }
}

struct ActiveRatePlanCardView: View {
    let timeline: SiteTariffsTimelineResponse
    let now: Date

    var body: some View {
        CardContainer(title: "Currently active", symbol: "bolt.circle.fill", theme: .bill) {
            if let match = timeline.activePeriodNow(at: now) {
                HStack(spacing: 8) {
                    Circle().fill(match.window.touName.tintColor).frame(width: 9, height: 9)
                    Text(match.window.touName.displayName).font(.headline)
                    Spacer()
                    Text(RatePlanTimelineFormatting.windowTimeLabel(match.window))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                let buy = RateFormatting.formatRate(match.window.buyRate, currency: timeline.currency)
                let sell = RateFormatting.formatRate(match.window.sellRate, currency: timeline.currency)
                Text("Buy \(buy) · Sell \(sell)")
                    .font(.subheadline.monospacedDigit())
                Text("\(match.period.name) · \(match.season.name)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("No active rate period scheduled right now.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
