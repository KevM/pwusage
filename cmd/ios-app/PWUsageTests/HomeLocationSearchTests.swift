import CoreLocation
import Foundation
@testable import PWUsage
import Testing

@MainActor
private final class StubCompleter: HomeLocationCompleting {
    var onResults: (([HomeLocationSuggestion]) -> Void)?
    private(set) var queries: [String] = []
    var coordinates: [String: CLLocationCoordinate2D] = [:]

    func search(_ query: String) { queries.append(query) }

    func coordinate(for suggestion: HomeLocationSuggestion) async throws -> CLLocationCoordinate2D {
        guard let coordinate = coordinates[suggestion.id] else { throw HomeLocationSearchError.notFound }
        return coordinate
    }
}

@MainActor
@Suite("Home location search and saving")
struct HomeLocationSearchTests {
    @Test func typingAsksForSuggestionsAndAnEmptyQueryClearsThem() {
        let completer = StubCompleter()
        let model = HomeLocationSearchModel(completer: completer)
        model.query = "53202"
        #expect(completer.queries == ["53202"])
        completer.onResults?([HomeLocationSuggestion(id: "a", title: "Milwaukee, WI 53202", subtitle: "United States")])
        #expect(model.suggestions.map(\.title) == ["Milwaukee, WI 53202"])
        model.query = "  "
        #expect(model.suggestions.isEmpty)
        #expect(completer.queries == ["53202"])
    }

    @Test func aChosenSuggestionBecomesARoundedSearchedLocation() async throws {
        let completer = StubCompleter()
        completer.coordinates["a"] = CLLocationCoordinate2D(latitude: 43.04123, longitude: -87.90987)
        let model = HomeLocationSearchModel(completer: completer)
        let location = try await model.location(
            for: HomeLocationSuggestion(id: "a", title: "Milwaukee", subtitle: ""))
        #expect(location == SolarHomeLocation(latitude: 43.04, longitude: -87.91, source: .searched))
    }

    @Test func aPinnedPointIsAMapLocationUnlessItIsTheSearchedOne() {
        let searched = CLLocationCoordinate2D(latitude: 43.04123, longitude: -87.90987)
        #expect(HomeLocationSearchModel.pinned(searched, searched: searched).source == .searched)
        let moved = CLLocationCoordinate2D(latitude: 43.06, longitude: -87.95)
        let pinned = HomeLocationSearchModel.pinned(moved, searched: searched)
        #expect(pinned == SolarHomeLocation(latitude: 43.06, longitude: -87.95, source: .map))
        #expect(HomeLocationSearchModel.pinned(moved, searched: nil).source == .map)
    }

    @Test func olderAndNewerSourcesDecode() throws {
        let decoder = JSONDecoder()
        for source in ["estimated", "device", "searched", "map"] {
            let json = Data(#"{"latitude":43.04,"longitude":-87.91,"source":"\#(source)"}"#.utf8)
            #expect(try decoder.decode(SolarHomeLocation.self, from: json).source.rawValue == source)
        }
        let legacy = Data(#"{"latitude":43.04,"longitude":-87.91}"#.utf8)
        #expect(try decoder.decode(SolarHomeLocation.self, from: legacy).source == .device)
        #expect(SolarLocationSource.searched.isExact)
        #expect(SolarLocationSource.map.isExact)
        #expect(!SolarLocationSource.estimated.isExact)
    }

    @Test func savingAChosenLocationStoresItForThisSiteOnly() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setNeedsLocation()
        await harness.coordinator.loadTimingDetailAppeared()
        let accountScopeID = try #require(harness.coordinator.accountScopeID)
        let other = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: "site-b")
        let before = try await harness.records.record(scope: other)

        let chosen = SolarHomeLocation(latitude: 43.04123, longitude: -87.90987, source: .searched)
        let result = await harness.coordinator.saveHomeLocation(chosen, confirmedSiteID: "site-a")

        #expect(result == .shared)
        let scope = SolarForecastSiteScope(accountScopeID: accountScopeID, siteID: "site-a")
        #expect(try await harness.records.record(scope: scope)?.location
            == SolarHomeLocation(latitude: 43.04, longitude: -87.91, source: .searched))
        #expect(try await harness.records.record(scope: other) == before)
    }

    @Test func savingForASiteNoLongerSelectedDoesNothing() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let chosen = SolarHomeLocation(latitude: 43.04, longitude: -87.91, source: .map)
        #expect(await harness.coordinator.saveHomeLocation(chosen, confirmedSiteID: "site-b") == .cancelled)
    }
}
