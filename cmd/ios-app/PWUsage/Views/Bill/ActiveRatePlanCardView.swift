import SwiftUI

struct TariffTimelineActions: Sendable {
    var load: @MainActor () async throws -> SiteTariffsTimelineResponse
    var refreshFromTesla: @MainActor () async throws -> SiteTariffsTimelineResponse
    var createPeriod: @MainActor (TariffPlanWriteRequest) async throws -> SiteTariffsTimelineResponse
    var updatePeriod: @MainActor (Int, TariffPlanPatchRequest) async throws -> SiteTariffsTimelineResponse
    var deletePeriod: @MainActor (Int) async throws -> SiteTariffsTimelineResponse
    var retryReattribution: @MainActor () async throws -> SiteTariffsTimelineResponse
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
