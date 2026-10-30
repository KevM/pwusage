#if DEBUG
    import SwiftUI

    /// Offline previews of the automatic forecast section, one per layout state. Synthetic
    /// coordinates only.
    private enum AutomaticSectionPreviewState: String, CaseIterable {
        case detected, estimated, needsLocation, pending, notEnoughHistory, lowConfidence

        var response: MobileSolarLayoutResponse {
            let device = SolarHomeLocation(latitude: 40.0, longitude: -90.0, source: .device)
            let layout = SolarLayout(
                planes: [
                    SolarLayoutPlane(azimuth: 90, tilt: 18, dcKwp: 5.6),
                    SolarLayoutPlane(azimuth: 270, tilt: 18, dcKwp: 4)
                ],
                acClipKw: nil, confidence: .high, detectedAt: nil
            )
            switch self {
            case .detected: return .enabled(location: device, layout: layout, reason: nil)
            case .estimated:
                let estimated = SolarHomeLocation(latitude: 40.0, longitude: -90.0, source: .estimated)
                return .enabled(location: estimated, layout: layout, reason: nil)
            case .needsLocation: return .enabled(location: nil, layout: nil, reason: .needsLocation)
            case .pending: return .enabled(location: device, layout: nil, reason: .pending)
            case .notEnoughHistory: return .enabled(location: device, layout: nil, reason: .notEnoughHistory)
            case .lowConfidence: return .enabled(location: device, layout: nil, reason: .lowConfidence)
            }
        }
    }

    private struct AutomaticSectionPreview: View {
        @StateObject private var coordinator: DashboardCoordinator

        init(state: AutomaticSectionPreviewState) {
            let coordinator = DashboardCoordinator(
                siteID: "preview-home", api: DashboardPreviewAPI(mode: .normal), timerInterval: nil
            )
            coordinator.solarLayoutStatus = state.response
            _coordinator = StateObject(wrappedValue: coordinator)
        }

        var body: some View {
            Form { SolarForecastAutomaticSection(coordinator: coordinator) }
        }
    }

    #Preview("Detected layout") { AutomaticSectionPreview(state: .detected) }
    #Preview("Estimated location") { AutomaticSectionPreview(state: .estimated) }
    #Preview("Needs location") { AutomaticSectionPreview(state: .needsLocation) }
    #Preview("Pending detection") { AutomaticSectionPreview(state: .pending) }
    #Preview("Not enough history") { AutomaticSectionPreview(state: .notEnoughHistory) }
    #Preview("Low confidence") { AutomaticSectionPreview(state: .lowConfidence) }
#endif
