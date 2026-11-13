import SwiftUI

/// Weather provenance remains linked wherever its data contributes to an estimate.
struct SolarForecastAttributionView: View {
    let attribution: String
    let url: URL?

    init(descriptor: SolarForecastProviderDescriptor) {
        self.init(attribution: descriptor.attribution, url: descriptor.attributionURL)
    }

    init(attribution: String, url: URL?) {
        self.attribution = attribution
        self.url = url
    }

    var body: some View {
        if let url {
            Link(attribution, destination: url)
        } else {
            Text(attribution)
        }
    }
}
