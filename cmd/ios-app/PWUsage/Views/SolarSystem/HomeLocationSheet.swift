import MapKit
import PWUsageCore
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
    @State private var work: Work?
    @State private var mapStart: MapStart?

    /// Where the map step opens: a searched place, or the device's region.
    struct MapStart: Hashable {
        let latitude: Double?
        let longitude: Double?
    }

    /// What is running, so only that row shows a spinner; every choice waits while any runs.
    private enum Work: Equatable {
        case currentLocation
        case suggestion(HomeLocationSuggestion.ID)
        case saving
    }

    private var isWorking: Bool { work != nil }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Task { await useCurrentLocation() }
                    } label: {
                        BusyRowLabel(isBusy: work == .currentLocation) {
                            Label("Use My Current Location", systemImage: "location.fill")
                        }
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
                            BusyRowLabel(isBusy: work == .suggestion(suggestion.id)) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(suggestion.title).foregroundStyle(.primary)
                                    if !suggestion.subtitle.isEmpty {
                                        Text(suggestion.subtitle).font(.footnote).foregroundStyle(.secondary)
                                    }
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
                HomeLocationMapStep(start: start, isSaving: work == .saving) { location in
                    Task { await save(location) }
                }
            }
        }
    }

    private func useCurrentLocation() async {
        work = .currentLocation
        defer { work = nil }
        let result = await coordinator.shareHomeLocation(
            confirmedSiteID: coordinator.selectedSiteID, provider: DeviceHomeLocationProvider())
        finish(result)
    }

    private func choose(_ suggestion: HomeLocationSuggestion) async {
        work = .suggestion(suggestion.id)
        defer { work = nil }
        guard let location = try? await search.location(for: suggestion) else {
            outcome = .unavailable
            return
        }
        mapStart = MapStart(latitude: location.latitude, longitude: location.longitude)
    }

    private func save(_ location: SolarHomeLocation) async {
        guard !isWorking else { return }
        work = .saving
        defer { work = nil }
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
    let isSaving: Bool
    let onConfirm: (SolarHomeLocation) -> Void

    // periphery:ignore - read through its $binding by Map
    @State private var position: MapCameraPosition
    @State private var center: CLLocationCoordinate2D?

    init(
        start: HomeLocationSheet.MapStart,
        isSaving: Bool,
        onConfirm: @escaping (SolarHomeLocation) -> Void
    ) {
        self.start = start
        self.isSaving = isSaving
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
                ProminentActionButton(
                    title: "Use This Location", busyTitle: "Saving…", isBusy: isSaving, isEnabled: center != nil
                ) {
                    if let center { onConfirm(HomeLocationSearchModel.pinned(center, searched: searched)) }
                }
                .controlSize(.large)
                .padding()
            }
            .navigationTitle("Move the Map to Your Home")
            .navigationBarTitleDisplayMode(.inline)
            .accessibilityElement(children: .contain)
    }
}
