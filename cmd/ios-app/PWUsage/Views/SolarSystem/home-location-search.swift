import CoreLocation
import Foundation
import MapKit
import Observation

/// An address or ZIP code suggestion while the user types.
struct HomeLocationSuggestion: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let subtitle: String
}

enum HomeLocationSearchError: Error { case notFound }

/// Suggestions as the user types, and a chosen one's coordinates. Queries go to Apple; no
/// location permission is needed.
@MainActor
protocol HomeLocationCompleting: AnyObject {
    var onResults: (([HomeLocationSuggestion]) -> Void)? { get set }
    func search(_ query: String)
    func coordinate(for suggestion: HomeLocationSuggestion) async throws -> CLLocationCoordinate2D
}

/// The home location sheet's search: suggestions for the query, and the rounded location a
/// suggestion or a map pin stands for.
@MainActor
@Observable
final class HomeLocationSearchModel {
    var query = "" {
        didSet {
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed != oldValue.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            if trimmed.isEmpty {
                suggestions = []
            } else {
                completer.search(trimmed)
            }
        }
    }

    private(set) var suggestions: [HomeLocationSuggestion] = []
    @ObservationIgnored private let completer: any HomeLocationCompleting

    init(completer: (any HomeLocationCompleting)? = nil) {
        self.completer = completer ?? MapKitHomeLocationCompleter()
        self.completer.onResults = { [weak self] results in
            guard let self, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            suggestions = results
        }
    }

    /// A chosen suggestion's location, rounded to hundredths (about 1 km) like every home location.
    func location(for suggestion: HomeLocationSuggestion) async throws -> SolarHomeLocation {
        let coordinate = try await completer.coordinate(for: suggestion)
        return Self.location(coordinate, source: .searched)
    }

    /// The map's center pin: still the searched place if the user did not move it away.
    static func pinned(_ center: CLLocationCoordinate2D, searched: CLLocationCoordinate2D?) -> SolarHomeLocation {
        let pin = location(center, source: .map)
        guard let searched else { return pin }
        let original = location(searched, source: .searched)
        return pin.sharesCoordinates(with: original) ? original : pin
    }

    static func location(_ coordinate: CLLocationCoordinate2D, source: SolarLocationSource) -> SolarHomeLocation {
        SolarHomeLocation(latitude: coordinate.latitude, longitude: coordinate.longitude, source: source).rounded
    }
}

/// `MKLocalSearchCompleter` for addresses and postal codes, and `MKLocalSearch` to resolve one.
@MainActor
final class MapKitHomeLocationCompleter: NSObject, HomeLocationCompleting, MKLocalSearchCompleterDelegate {
    var onResults: (([HomeLocationSuggestion]) -> Void)?
    private let completer = MKLocalSearchCompleter()
    private var completions: [String: MKLocalSearchCompletion] = [:]

    override init() {
        super.init()
        completer.resultTypes = .address
        completer.delegate = self
    }

    func search(_ query: String) {
        completer.queryFragment = query
    }

    func coordinate(for suggestion: HomeLocationSuggestion) async throws -> CLLocationCoordinate2D {
        guard let completion = completions[suggestion.id] else { throw HomeLocationSearchError.notFound }
        let response = try await MKLocalSearch(request: MKLocalSearch.Request(completion: completion)).start()
        guard let item = response.mapItems.first else { throw HomeLocationSearchError.notFound }
        return item.placemark.coordinate
    }

    /// MapKit calls back on the main thread; the results are read from the owned completer.
    nonisolated func completerDidUpdateResults(_: MKLocalSearchCompleter) {
        MainActor.assumeIsolated { publish() }
    }

    private func publish() {
        var completions: [String: MKLocalSearchCompletion] = [:]
        let suggestions = completer.results.map { completion in
            let suggestion = HomeLocationSuggestion(
                id: "\(completion.title)|\(completion.subtitle)", title: completion.title,
                subtitle: completion.subtitle)
            completions[suggestion.id] = completions[suggestion.id] ?? completion
            return suggestion
        }
        self.completions = completions
        onResults?(suggestions)
    }

    nonisolated func completer(_: MKLocalSearchCompleter, didFailWithError _: any Error) {
        MainActor.assumeIsolated { onResults?([]) }
    }
}
