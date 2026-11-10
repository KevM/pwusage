import Foundation
@testable import PWUsage
import Testing

@Suite("Home loading presentation")
struct HomeLoadingPresentationTests {
    private let start = Date(timeIntervalSinceReferenceDate: 1000)

    private func status(response: Bool, since: Date? = nil, failed: Bool = false) -> HomeEndpointStatus {
        HomeEndpointStatus(hasResponse: response,
                           wait: since.map { FreshReadingWait(since: $0, hasFailed: failed) })
    }

    @Test("A card loads, waits, turns slow at 10 seconds, or breaks")
    func phaseRules() {
        #expect(HomeLoadingPresentation.phase(status(response: true), now: start) == .loaded)
        #expect(HomeLoadingPresentation.phase(status(response: true, since: start, failed: true), now: start)
            == .broken)
        #expect(HomeLoadingPresentation.phase(status(response: false), now: start) == .waiting(isSlow: false))
        #expect(HomeLoadingPresentation.phase(status(response: true, since: start),
                                              now: start.addingTimeInterval(9.9)) == .waiting(isSlow: false))
        #expect(HomeLoadingPresentation.phase(status(response: false, since: start),
                                              now: start.addingTimeInterval(10)) == .waiting(isSlow: true))
    }

    @Test("Live loads from either endpoint and breaks only when both fail")
    func livePhaseCombinesEndpoints() {
        let broken = status(response: false, since: start, failed: true)
        let waiting = status(response: false, since: start)
        let slow = status(response: false, since: start.addingTimeInterval(-20))
        #expect(HomeLoadingPresentation.livePhase(power: broken, live: waiting, now: start)
            == .waiting(isSlow: false))
        #expect(HomeLoadingPresentation.livePhase(power: broken, live: status(response: true), now: start)
            == .loaded)
        #expect(HomeLoadingPresentation.livePhase(power: broken, live: broken, now: start) == .broken)
        #expect(HomeLoadingPresentation.livePhase(power: slow, live: waiting, now: start)
            == .waiting(isSlow: true))
    }

    @Test("Story lines rotate, and slow and broken lines replace them")
    func linesRotateAndSlowWins() {
        let waiting = HomeCardPhase.waiting(isSlow: false)
        func line(_ seconds: TimeInterval, _ phase: HomeCardPhase = .waiting(isSlow: false)) -> String {
            HomeLoadingPresentation.line(for: .live, phase: phase,
                                         now: Date(timeIntervalSinceReferenceDate: seconds))
        }
        #expect(line(0, waiting) == "Reaching your Powerwall…")
        #expect(line(2.4) == "Checking your solar…")
        #expect(line(7.2) == "Reaching your Powerwall…")
        #expect(line(0, .waiting(isSlow: true)) == "Taking longer than usual…")
        #expect(line(0, .broken) == "Couldn’t reach your Powerwall.")
    }

    @Test("VoiceOver reads a waiting card as loading and a broken one with its next step")
    func voiceOverLabels() {
        #expect(HomeLoadingPresentation.accessibilityLabel(for: .bill, phase: .waiting(isSlow: false))
            == "Current Bill, loading")
        #expect(HomeLoadingPresentation.accessibilityLabel(for: .bill, phase: .broken)
            == "Current Bill. Couldn’t estimate your bill. Pull down to try again.")
    }
}
