import MapKit
import SwiftUI

/// One sheet, three ways to set the home location: the current location once ("I'm at home
/// now"), an address or ZIP code search, or a pin on a map. Each is rounded to about 1 km and
/// saved on this device (and the iCloud layout sync) only.
struct HomeLocationSheet: View {
    @ObservedObject var coordinator: DashboardCoordinator
    let onSaved: (SolarLocationShareResult) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var search = HomeLocationSearchModel()
    @State private var outcome: SolarLocationShareResult?
    @State private var isWorking = false
    @State private var mapStart: MapStart?

    /// Where the map step opens: a searched place, or the device's region.
    struct MapStart: Hashable {
        let latitude: Double?
        let longitude: Double?
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Task { await useCurrentLocation() }
                    } label: {
                        Label("Use My Current Location", systemImage: "location.fill")
                    }
                    .disabled(isWorking)
                    if let outcome { SolarLocationOutcomeView(outcome: outcome) }
                } header: {
                    Text("I’m at home now")
                } footer: {
                    Text("pwusage reads your location once. Choose Allow Once if you prefer.")
                }
                Section {
                    TextField("Address or ZIP code", text: $search.query)
                        .textContentType(.fullStreetAddress)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                    ForEach(search.suggestions) { suggestion in
                        Button {
                            Task { await choose(suggestion) }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(suggestion.title).foregroundStyle(.primary)
                                if !suggestion.subtitle.isEmpty {
                                    Text(suggestion.subtitle).font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(isWorking)
                    }
                } header: {
                    Text("Search")
                }
                Section {
                    Button {
                        mapStart = MapStart(latitude: nil, longitude: nil)
                    } label: {
                        Label("Choose on Map", systemImage: "map")
                    }
                } footer: {
                    Text("Searches go to Apple to find matching places. Latitude and longitude are rounded to "
                        + "two decimals (about 1 km) and saved on this device and in your iCloud. "
                        + "The app sends the rounded coordinates to Open-Meteo for forecasts and weather history.")
                }
            }
            .navigationTitle("Home Location")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .navigationDestination(item: $mapStart) { start in
                HomeLocationMapStep(start: start) { location in
                    Task { await save(location) }
                }
            }
        }
    }

    private func useCurrentLocation() async {
        isWorking = true
        defer { isWorking = false }
        let result = await coordinator.shareHomeLocation(
            confirmedSiteID: coordinator.selectedSiteID, provider: DeviceHomeLocationProvider())
        finish(result)
    }

    private func choose(_ suggestion: HomeLocationSuggestion) async {
        isWorking = true
        defer { isWorking = false }
        guard let location = try? await search.location(for: suggestion) else {
            outcome = .unavailable
            return
        }
        mapStart = MapStart(latitude: location.latitude, longitude: location.longitude)
    }

    private func save(_ location: SolarHomeLocation) async {
        isWorking = true
        defer { isWorking = false }
        finish(await coordinator.saveHomeLocation(location, confirmedSiteID: coordinator.selectedSiteID))
    }

    private func finish(_ result: SolarLocationShareResult) {
        if result == .shared {
            onSaved(result)
            dismiss()
        } else {
            mapStart = nil
            outcome = result
        }
    }
}

/// A fixed center pin over a map the user drags, then confirms.
struct HomeLocationMapStep: View {
    let start: HomeLocationSheet.MapStart
    let onConfirm: (SolarHomeLocation) -> Void

    @State private var position: MapCameraPosition
    @State private var center: CLLocationCoordinate2D?

    init(start: HomeLocationSheet.MapStart, onConfirm: @escaping (SolarHomeLocation) -> Void) {
        self.start = start
        self.onConfirm = onConfirm
        if let latitude = start.latitude, let longitude = start.longitude {
            let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
            _position = State(initialValue: .region(MKCoordinateRegion(
                center: coordinate, latitudinalMeters: 3000, longitudinalMeters: 3000)))
            _center = State(initialValue: coordinate)
        } else {
            _position = State(initialValue: .automatic)
        }
    }

    private var searched: CLLocationCoordinate2D? {
        guard let latitude = start.latitude, let longitude = start.longitude else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    var body: some View {
        Map(position: $position)
            .onMapCameraChange(frequency: .onEnd) { context in center = context.region.center }
            .overlay {
                Image(systemName: "mappin")
                    .font(.largeTitle)
                    .foregroundStyle(.red)
                    .offset(y: -16)
                    .accessibilityHidden(true)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    if let center { onConfirm(HomeLocationSearchModel.pinned(center, searched: searched)) }
                } label: {
                    Text("Use This Location").frame(maxWidth: .infinity)
                }
                .emphasisProminentButton()
                .controlSize(.large)
                .disabled(center == nil)
                .padding()
            }
            .navigationTitle("Move the Map to Your Home")
            .navigationBarTitleDisplayMode(.inline)
            .accessibilityElement(children: .contain)
    }
}
