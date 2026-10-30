import SwiftUI

/// Weather provenance remains linked wherever its data contributes to an estimate.
struct SolarForecastAttributionView: View {
    let descriptor: SolarForecastProviderDescriptor

    var body: some View {
        if let url = descriptor.attributionURL {
            Link(descriptor.attribution, destination: url)
        } else {
            Text(descriptor.attribution)
        }
    }
}
