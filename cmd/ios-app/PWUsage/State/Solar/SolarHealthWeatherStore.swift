import Foundation
import OSLog

/// Local, per-site ERA5 archive. A failed fetch leaves any previously saved days usable.
actor SolarHealthWeatherStore {
    static let shared = SolarHealthWeatherStore()

    struct Place: Codable, Equatable, Sendable {
        let latitude: Double
        let longitude: Double
        let timeZone: TimeZone

        init(location: SolarHomeLocation, timeZone: TimeZone) {
            latitude = location.rounded.latitude
            longitude = location.rounded.longitude
            self.timeZone = timeZone
        }

        var location: SolarHomeLocation {
            SolarHomeLocation(latitude: latitude, longitude: longitude, source: .device)
        }
    }

    private struct Snapshot: Codable {
        let place: Place
        var days: ClosedRange<String>
        var weather: SolarHealthWeather

        mutating func include(_ other: SolarHealthWeather, in range: ClosedRange<String>) {
            days = min(days.lowerBound, range.lowerBound) ... max(days.upperBound, range.upperBound)
            weather.formUnion(other)
        }

        func missing(in requested: ClosedRange<String>) -> [ClosedRange<String>] {
            var ranges: [ClosedRange<String>] = []
            if requested.lowerBound < days.lowerBound,
               let end = SiteLocalDays.adding(-1, to: days.lowerBound, timeZone: place.timeZone) {
                ranges.append(requested.lowerBound ... end)
            }
            if requested.upperBound > days.upperBound,
               let start = SiteLocalDays.adding(1, to: days.upperBound, timeZone: place.timeZone) {
                ranges.append(start ... requested.upperBound)
            }
            return ranges
        }
    }

    private let client: OpenMeteoClient
    private let logger = Logger(subsystem: "rodeo.fm.pwusage", category: "SolarHealthWeather")
    private var retryAt: Date?

    init(client: OpenMeteoClient = OpenMeteoClient()) {
        self.client = client
    }

    func weather(
        scope: SolarForecastSiteScope, cache: SolarHealthCache, place: Place,
        samples: ClosedRange<Date>, now: Date
    ) async throws -> SolarHealthWeather {
        let timeZone = place.timeZone
        let first = SiteLocalDays.today(now: samples.lowerBound, timeZone: timeZone)
        let today = SiteLocalDays.today(now: now, timeZone: timeZone)
        // ERA5 is published about five days late. Leave a buffer for a complete local day.
        guard let available = SiteLocalDays.adding(-7, to: today, timeZone: timeZone) else { return .init() }
        let last = min(available, SiteLocalDays.today(now: samples.upperBound, timeZone: timeZone))
        guard first <= last else { return .init() }

        let days = first ... last
        let file = cache.siteDirectory(scope).appendingPathComponent("weather-era5.json")
        var snapshot = read(file, place: place)
        if retryAt.map({ now >= $0 }) ?? true {
            snapshot = try await refresh(snapshot, days: days, place: place, file: file, now: now)
        }
        let weather = snapshot?.weather ?? .init()
        return SolarHealthWeather(
            rainDays: weather.rainDays.filter { days.contains($0) },
            snowDays: weather.snowDays.filter { days.contains($0) })
    }

    private func refresh(
        _ cached: Snapshot?, days: ClosedRange<String>, place: Place, file: URL, now: Date
    ) async throws -> Snapshot? {
        var snapshot = cached
        for range in cached?.missing(in: days) ?? [days] {
            do {
                let weather = try await client.weatherHistory(
                    location: place.location, timeZone: place.timeZone, days: range)
                try Task.checkCancellation()
                var updated = snapshot ?? Snapshot(place: place, days: range, weather: .init())
                updated.include(weather, in: range)
                if let stored = read(file, place: place),
                   let gap = SiteLocalDays.days(
                       from: min(stored.days.upperBound, updated.days.upperBound),
                       to: max(stored.days.lowerBound, updated.days.lowerBound), timeZone: place.timeZone),
                   gap <= 1 {
                    updated.include(stored.weather, in: stored.days)
                }
                snapshot = updated
                save(updated, to: file)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if case OpenMeteoClientError.rateLimited(let retryAfter) = error, let retryAfter {
                    retryAt = retryAfter
                } else {
                    retryAt = now.addingTimeInterval(OpenMeteoClient.defaultDeferral)
                }
                try Task.checkCancellation()
                logger.debug("Weather history unavailable: \(error.localizedDescription, privacy: .private)")
                break
            }
        }
        return snapshot
    }

    private func read(_ file: URL, place: Place) -> Snapshot? {
        guard let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
              snapshot.place == place else { return nil }
        return snapshot
    }

    private func save(_ snapshot: Snapshot, to file: URL) {
        do {
            var directory = file.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            try JSONEncoder().encode(snapshot).write(
                to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            logger.debug("Could not save weather history: \(error.localizedDescription, privacy: .private)")
        }
    }
}
