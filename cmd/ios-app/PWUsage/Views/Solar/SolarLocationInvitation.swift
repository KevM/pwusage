import SwiftUI

/// The one-time Smart Shift invitation to share (or refine) the home location. It never asks for
/// permission itself: the button opens the home location sheet, where
/// the user chooses the current location, a search or a map pin.
enum SolarLocationInvitation {
    enum Kind: Equatable {
        case missing
        case estimated

        var message: String {
            switch self {
            case .missing:
                "Share your home location to add a solar forecast to Smart Shift."
            case .estimated:
                "Your forecast uses an approximate location. Share your exact home location for a better one."
            }
        }
    }

    static func kind(status: MobileSolarLayoutResponse?) -> Kind? {
        guard case .enabled(let location, _, let reason) = status else { return nil }
        if location?.source == .estimated { return .estimated }
        return location == nil && reason == .needsLocation ? .missing : nil
    }

    /// Dismissal survives relaunch, per account and site.
    struct Dismissals {
        let defaults: UserDefaults

        private func key(_ scope: SolarForecastSiteScope) -> String {
            "solarLocationInvitationDismissed.\(SolarForecastScope.key(scope.accountScopeID, scope.siteID))"
        }

        func isDismissed(_ scope: SolarForecastSiteScope) -> Bool { defaults.bool(forKey: key(scope)) }
        func dismiss(_ scope: SolarForecastSiteScope) { defaults.set(true, forKey: key(scope)) }
    }
}

struct SolarLocationInvitationCard: View {
    @ObservedObject var coordinator: DashboardCoordinator
    var defaults: UserDefaults = .standard
    @State private var dismissed = false
    @State private var isConfirming = false
    @State private var outcome: SolarLocationShareResult?

    private var kind: SolarLocationInvitation.Kind? {
        SolarLocationInvitation.kind(
            status: coordinator.solarLayoutStatus
        )
    }

    var body: some View {
        if let kind, let scope = coordinator.solarScope, !dismissed,
           !SolarLocationInvitation.Dismissals(defaults: defaults).isDismissed(scope) {
            VStack(alignment: .leading, spacing: 10) {
                Text(kind.message)
                if let outcome {
                    SolarLocationOutcomeView(outcome: outcome)
                }
                HStack {
                    Button(kind == .estimated ? "Use My Exact Home Location" : "Use My Home Location") {
                        isConfirming = true
                    }
                    .emphasisProminentButton()
                    Button("Not Now") { dismiss(scope) }
                }
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20))
            .sheet(isPresented: $isConfirming) {
                HomeLocationSheet(coordinator: coordinator) { result in
                    outcome = result
                    dismiss(scope)
                }
            }
        }
    }

    private func dismiss(_ scope: SolarForecastSiteScope) {
        SolarLocationInvitation.Dismissals(defaults: defaults).dismiss(scope)
        dismissed = true
    }
}

/// What happened after a location request, with Open Settings only for a refused permission.
struct SolarLocationOutcomeView: View {
    let outcome: SolarLocationShareResult
    @Environment(\.openURL) private var openURL

    var body: some View {
        switch outcome {
        case .shared:
            Text("Location shared. Your panel layout will be detected from it.")
                .foregroundStyle(.secondary)
        case .denied, .restricted:
            Text("Location access is off for pwusage. Turn it on in Settings to share your home location.")
                .foregroundStyle(.secondary)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
        case .unavailable:
            Text("Your location could not be found. Try again when you're at home.").foregroundStyle(.secondary)
        case .failed:
            Text("Your location could not be saved. Try again later.").foregroundStyle(.secondary)
        case .cancelled:
            EmptyView()
        }
    }
}
