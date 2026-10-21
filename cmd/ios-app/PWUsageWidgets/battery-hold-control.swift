import AppIntents
import SwiftUI
import WidgetKit

struct BatteryHoldControlConfiguration: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "pwusage Battery Saver"
    @Parameter(title: "Site") var site: BatteryHoldControlSite?
    static var parameterSummary: some ParameterSummary { Summary("Open Battery Saver for \(\.$site)") }
}

struct BatteryHoldControlProvider: AppIntentControlValueProvider {
    func previewValue(configuration: BatteryHoldControlConfiguration) -> BatteryHoldControlSite {
        configuration.site ?? BatteryHoldControlSite(id: "", name: "Choose a site")
    }
    func currentValue(configuration: BatteryHoldControlConfiguration) async throws -> BatteryHoldControlSite {
        previewValue(configuration: configuration)
    }
}

struct BatteryHoldControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(kind: BatteryHoldControlIdentity.kind, provider: BatteryHoldControlProvider()) { site in
            ControlWidgetButton(action: OpenBatteryHoldIntent(site: site)) {
                // Control Center draws the resting tile from this label.
                Label("pwusage", systemImage: BatteryHoldControlIdentity.symbolName)
            } actionLabel: { _ in
                Text(site.name)
            }
        }
        .displayName("pwusage Battery Saver")
        .description("Saves your Powerwall charge for when rates spike. Opens pwusage to turn Battery Saver on or off. Sign in to the app first to choose a site.")
        .promptsForUserConfiguration()
    }
}
