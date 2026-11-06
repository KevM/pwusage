import Foundation

/// What the Solar System screen, its Settings row and the banner say about finding a site's
/// solar system. Counts are the phone's stored days and the latest clear-day pass; there is no
/// checked-days count and no denominator, since the search can extend.
struct SiteHistoryPresentation: Equatable {
    enum Phase: Equatable {
        case loading, waiting, needsLocation, needsReconnect, foundImproving, foundFinal, unavailable
    }

    enum Action: Equatable { case addLocation, reconnectTesla, useExactLocation }

    static let title = "Finding your solar system"

    let phase: Phase
    /// The short value on the Settings row.
    let rowValue: String
    /// The one line under the visual; empty once found, when the System card says it all.
    let statusLine: String
    let action: Action?
    let accessibilitySummary: String
    let showsBanner: Bool
    let downloadedDays: Int
    let producingDays: Int
    let clearDays: Int
    /// "96 days downloaded, 21 clear", just the downloaded days before the first pass, or empty.
    let countsText: String

    init(status: SiteHistoryStatus?, now: Date, timeZone: TimeZone = .current) {
        downloadedDays = status?.downloadedDays ?? 0
        producingDays = status?.producingDays ?? 0
        clearDays = status?.clearDays ?? 0
        countsText = Self.counts(status)
        let phase = Self.phase(status, now: now)
        self.phase = phase
        let wording = Self.wording(phase, status: status, now: now, timeZone: timeZone)
        rowValue = wording.row
        statusLine = wording.line
        action = Self.action(phase, status: status)
        let isActive = status?.progress?.phase == .active
        let showsForPhase = switch phase {
        case .loading, .waiting: isActive
        case .needsLocation: status?.progress != nil
        case .needsReconnect, .foundImproving, .foundFinal, .unavailable: false
        }
        // A found system nobody has seen stays up in any phase, until it is seen.
        showsBanner = showsForPhase || status?.isRevealOwed == true
        accessibilitySummary = Self.summary(phase, line: wording.line, status: status)
    }

    // MARK: - Phase

    private static func phase(_ status: SiteHistoryStatus?, now: Date) -> Phase {
        guard let status else { return .loading }
        let progressPhase = status.progress?.phase
        if case .paused? = progressPhase { return .needsReconnect }
        if let layout = status.layout {
            let stillLoading = progressPhase == .active
            return layout.confidence == .high || !stillLoading ? .foundFinal : .foundImproving
        }
        if case .finished(.historyUnavailable)? = progressPhase { return .unavailable }
        if status.location == .none { return .needsLocation }
        switch progressPhase {
        case nil, .active, .finished(.locationNeeded):
            let waitingUntil = [status.throttledUntil, status.progress?.nextAttemptAt].compactMap(\.self).max()
            return (waitingUntil ?? .distantPast) > now ? .waiting : .loading
        case .finished, .paused:
            return .unavailable
        }
    }

    private static func action(_ phase: Phase, status: SiteHistoryStatus?) -> Action? {
        switch phase {
        case .needsLocation: return .addLocation
        case .needsReconnect:
            return status?.progress?.phase == .paused(.reconnectTesla) ? .reconnectTesla : nil
        case .unavailable:
            return status?.location == .estimated ? .useExactLocation : nil
        case .loading, .waiting, .foundImproving, .foundFinal: return nil
        }
    }

    // MARK: - Wording

    private static func wording(
        _ phase: Phase, status: SiteHistoryStatus?, now: Date, timeZone: TimeZone
    ) -> (row: String, line: String) {
        let counts = Self.counts(status)
        switch phase {
        case .loading:
            return ("Loading", status?.progress == nil && counts.isEmpty ? "Starts while pwusage is open" : counts)
        case .waiting:
            let until = [status?.throttledUntil, status?.progress?.nextAttemptAt].compactMap(\.self).max() ?? now
            let isTesla = (status?.throttledUntil ?? .distantPast) > now
            let prefix = isTesla ? "Tesla is limiting requests. " : ""
            return ("Waiting", prefix + "Continues after \(time(until, now: now, timeZone)).")
        case .needsLocation:
            return ("Needs Location", "Add your location to find your solar system")
        case .needsReconnect:
            let signIn = status?.progress?.phase == .paused(.signIn)
            let line = signIn ? "Sign in again to keep loading history" : "Reconnect Tesla to keep loading history"
            return ("Paused", line)
        case .foundImproving:
            return ("Improving", "")
        case .foundFinal:
            return ("Found", "")
        case .unavailable:
            return unavailable(status?.progress?.phase)
        }
    }

    private static func unavailable(_ phase: SiteHistoryOnboardingProgress.Phase?) -> (row: String, line: String) {
        switch phase {
        case .finished(.historyUnavailable): ("Unavailable", "History isn’t available for this site yet")
        case .finished(.noSolarProduction): ("Not Found", "No solar production found")
        case .finished(.detectorNeedsOtherAction): ("Not Found", "Couldn’t find a layout from this history")
        default: ("Not Found", "Not enough clear days to find a layout yet")
        }
    }

    private static func counts(_ status: SiteHistoryStatus?) -> String {
        guard let status, status.downloadedDays > 0 else { return "" }
        let downloaded = days(status.downloadedDays) + " downloaded"
        return status.producingDays > 0 ? "\(downloaded), \(status.clearDays.formatted()) clear" : downloaded
    }

    private static func summary(_ phase: Phase, line: String, status: SiteHistoryStatus?) -> String {
        if let layout = status?.layout {
            return line.isEmpty ? describe(layout) : "\(describe(layout)) \(line)."
        }
        let counts = counts(status)
        let parts = [title, counts, line == counts ? "" : line].filter { !$0.isEmpty }
        return parts.joined(separator: ". ") + "."
    }

    /// "Solar system: 8.8 kilowatts, two panel groups, main group facing south-southwest, tilted
    /// 22 degrees, medium confidence."
    static func describe(_ layout: SolarLayout) -> String {
        let total = layout.planes.reduce(0) { $0 + $1.dcKwp }
        let size = total.formatted(.number.precision(.fractionLength(1)))
        var parts = ["Solar system: \(size) kilowatts"]
        if layout.planes.count > 1 {
            parts.append("\(spelled(layout.planes.count)) panel groups")
        }
        if let main = layout.planes.max(by: { $0.dcKwp < $1.dcKwp }) {
            let group = layout.planes.count > 1 ? "main group facing" : "facing"
            parts.append("\(group) \(SolarSystemCompass.name(main.azimuth))")
            parts.append("tilted \(Int(main.tilt.rounded())) degrees")
        }
        parts.append("\(layout.confidence.rawValue) confidence")
        return parts.joined(separator: ", ") + "."
    }

    private static func spelled(_ number: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .spellOut
        return formatter.string(for: number) ?? number.formatted()
    }

    static func days(_ count: Int) -> String {
        count == 1 ? "1 day" : "\(count.formatted()) days"
    }

    /// A time today, or a date and time further out.
    private static func time(_ date: Date, now: Date, _ timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var style = calendar.isDate(date, inSameDayAs: now)
            ? Date.FormatStyle(date: .omitted, time: .shortened)
            : Date.FormatStyle(date: .abbreviated, time: .shortened)
        style.timeZone = timeZone
        return date.formatted(style)
    }
}

/// Compass names for a direction in degrees.
enum SolarSystemCompass {
    private static let abbreviations = [
        "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    private static let names = [
        "north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast",
        "south-southeast", "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest",
        "northwest", "north-northwest"]

    private static func index(_ azimuth: Double) -> Int {
        let normalized = (azimuth.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        return Int((normalized / 22.5).rounded()) % 16
    }

    /// "SSW".
    static func abbreviation(_ azimuth: Double) -> String { abbreviations[index(azimuth)] }
    /// "south-southwest", for VoiceOver.
    static func name(_ azimuth: Double) -> String { names[index(azimuth)] }
}
