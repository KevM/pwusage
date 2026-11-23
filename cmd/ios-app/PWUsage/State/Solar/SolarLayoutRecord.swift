import Foundation
import PWUsageCore

struct SolarLayoutRemoteApplyOutcome: Equatable, Sendable {
    let record: SolarLayoutRecord
    let appliedScopes: [SolarForecastSiteScope]
}
