import Foundation

/// What one Home card shows: its real content, its waiting story, or a failure.
enum HomeCardPhase: Equatable {
    case waiting(isSlow: Bool)
    case broken
    case loaded
}

/// The part of an endpoint's state that decides a card's phase.
struct HomeEndpointStatus: Equatable {
    let hasResponse: Bool
    let wait: FreshReadingWait?
}

enum HomeCard: CaseIterable {
    case live, today, bill, smartShift

    var title: String {
        switch self {
        case .live: "Live power"
        case .today: "Today so far"
        case .bill: "Current Bill"
        case .smartShift: "Smart Shift"
        }
    }

    var waitingSymbol: String {
        switch self {
        case .live: "bolt.fill"
        case .today: "chart.bar.xaxis"
        case .bill: "dollarsign.circle"
        case .smartShift: "timer"
        }
    }

    var brokenSymbol: String {
        self == .live ? "bolt.slash.fill" : "exclamationmark.triangle"
    }

    /// These symbols have layers that light in turn; the others breathe.
    var usesVariableColor: Bool { self == .today || self == .bill }

    var storyLines: [String] {
        switch self {
        case .live: ["Reaching your Powerwall…", "Checking your solar…", "Reading the grid…"]
        case .today: ["Adding up today’s energy…", "Counting kilowatt-hours…"]
        case .bill: ["Estimating your bill…", "Applying your rate plan…"]
        case .smartShift: ["Checking your rate periods…", "Finding the cheapest times…"]
        }
    }

    var failureLine: String {
        switch self {
        case .live: "Couldn’t reach your Powerwall."
        case .today: "Couldn’t load today’s energy."
        case .bill: "Couldn’t estimate your bill."
        case .smartShift: "Couldn’t check your rate periods."
        }
    }
}

enum HomeLoadingPresentation {
    static let slowAfter: TimeInterval = 10
    static let lineInterval: TimeInterval = 2.4
    static let slowLine = "Taking longer than usual…"
    static let retryHint = "Pull down to try again."

    static func phase(_ status: HomeEndpointStatus, now: Date) -> HomeCardPhase {
        guard let wait = status.wait else {
            return status.hasResponse ? .loaded : .waiting(isSlow: false)
        }
        if wait.hasFailed { return .broken }
        return .waiting(isSlow: now.timeIntervalSince(wait.since) >= slowAfter)
    }

    /// The Live card draws from the fast power route or the summary's snapshot,
    /// so it loads when either arrives and breaks only when both have failed.
    static func livePhase(power: HomeEndpointStatus, live: HomeEndpointStatus, now: Date) -> HomeCardPhase {
        let phases = [phase(power, now: now), phase(live, now: now)]
        if phases.contains(.loaded) { return .loaded }
        if phases.allSatisfy({ $0 == .broken }) { return .broken }
        return .waiting(isSlow: phases.contains(.waiting(isSlow: true)))
    }

    static func line(for card: HomeCard, phase: HomeCardPhase, now: Date) -> String {
        switch phase {
        case .waiting(isSlow: true): slowLine
        case .waiting(isSlow: false):
            card.storyLines[Int(now.timeIntervalSinceReferenceDate / lineInterval) % card.storyLines.count]
        case .broken: card.failureLine
        case .loaded: ""
        }
    }

    static func accessibilityLabel(for card: HomeCard, phase: HomeCardPhase) -> String {
        switch phase {
        case .waiting: "\(card.title), loading"
        case .broken: "\(card.title). \(card.failureLine) \(retryHint)"
        case .loaded: card.title
        }
    }
}
