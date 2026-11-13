import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Site deep history model")
struct SiteDeepHistoryModelTests {
    let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    private let now = Date(timeIntervalSince1970: 1_793_642_400)

    private func make(
        _ environment: FakeOnboardingEnvironment, sleep: @escaping SiteDeepHistoryModel.Sleep = { _ in }
    ) -> SiteDeepHistoryModel {
        let store = SiteDeepHistoryStore(directory: directory)
        let deep = SiteDeepHistory(
            environment: environment, store: store, onboarding: SiteHistoryOnboardingStore(directory: directory),
            now: { now })
        return SiteDeepHistoryModel(deepHistory: deep, store: store, sleep: sleep, now: { now })
    }

    @Test func loadsToTheHistoryStartAndFinishes() async {
        let environment = FakeOnboardingEnvironment()
        environment.historyStart = "2026-10-20"
        let model = make(environment)
        await model.select(scope: scope)
        #expect(model.status.phase == .idle)
        model.start()
        #expect(model.status.phase == .running)
        await model.runTask?.value
        #expect(model.status == .init(phase: .finished, loadedBack: "2026-10-20", daysLoaded: 13))
    }

    @Test func aTeslaWaitShowsAsWaitingAndStopLeavesTheCursor() async throws {
        let retryAt = now.addingTimeInterval(600)
        let environment = FakeOnboardingEnvironment()
        environment.historyStart = "2026-08-20"
        environment.answers = [
            .fill(.complete),
            .failure(MobileSolarHistoryFillError.rateLimited(retryAt: retryAt, isFallback: false))
        ]
        let model = make(environment) { _ in try await Task.sleep(for: .seconds(60)) }
        await model.select(scope: scope)
        model.start()
        try await eventually { model.status.phase == .waiting(until: retryAt) }
        await model.stop()
        #expect(model.status.phase == .idle)
        #expect(model.status.loadedBack == "2026-09-03")
        #expect(model.runTask == nil)
    }

    @Test func aReconnectPauseIsShownAndResumesAfterTheReconnect() async {
        let environment = FakeOnboardingEnvironment()
        environment.historyStart = "2026-10-20"
        environment.answers = [.failure(MobileSolarHistoryFillError.teslaReconnectRequired)]
        let model = make(environment)
        await model.select(scope: scope)
        model.start()
        await model.runTask?.value
        #expect(model.status.phase == .paused(.reconnectTesla))
        await model.resumePaused(accountScopeID: scope.accountScopeID, reason: .reconnectTesla)
        await model.runTask?.value
        #expect(model.status.phase == .finished)
    }

    @Test func aDifferentSiteStopsTheRunAndSignOutClears() async {
        let environment = FakeOnboardingEnvironment()
        environment.fillDelay = .seconds(60)
        let model = make(environment)
        await model.select(scope: scope)
        model.start()
        await model.select(scope: .init(accountScopeID: "account-a", siteID: "site-2"))
        #expect(model.runTask == nil)
        #expect(model.status == .init())
        model.end()
        #expect(model.scope == nil)
    }

    @Test func presentationOffersTheRightActionAndStaysCalm() {
        func line(_ status: SiteDeepHistoryModel.Status) -> SiteDeepHistoryPresentation {
            SiteDeepHistoryPresentation(status: status)
        }
        #expect(line(.init()).action == .load)
        #expect(line(.init(phase: .idle, loadedBack: "2025-01-05", daysLoaded: 300)).action == .continueLoading)
        let running = line(.init(phase: .running, loadedBack: "2025-01-05", daysLoaded: 300))
        #expect(running.action == .stop)
        let back = SiteDeepHistoryPresentation.format("2025-01-05")
        #expect(running.accessoryDetail == "Back to \(back) · 300 days loaded")
        #expect(line(.init(phase: .paused(.reconnectTesla))).action == .reconnectTesla)
        #expect(line(.init(phase: .finished, loadedBack: "2020-03-01", daysLoaded: 900)).action == nil)
        let all = [SiteDeepHistoryPhase.idle, .running, .finished, .unavailable, .paused(.signIn)]
            .map { line(.init(phase: $0, loadedBack: "2024-02-02", daysLoaded: 5)) }
        #expect(all.allSatisfy { !$0.statusLine.contains("!") })
    }

    @Test func aPauseIsResumedForTheAccountBeforeAnySiteIsSelected() async throws {
        let store = SiteDeepHistoryStore(directory: directory)
        var signIn = SiteDeepHistoryProgress(oldestChecked: "2026-10-30")
        signIn.phase = .paused(.signIn)
        var reconnect = signIn
        reconnect.phase = .paused(.reconnectTesla)
        let other = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-2")
        let elsewhere = SolarForecastSiteScope(accountScopeID: "account-b", siteID: "site-1")
        try await store.save(signIn, scope: scope)
        try await store.save(reconnect, scope: other)
        try await store.save(signIn, scope: elsewhere)
        let model = make(FakeOnboardingEnvironment())
        await model.resumePaused(accountScopeID: "account-a", reason: .signIn)
        // A fresh store reads what the model's wrote to the file.
        let saved = SiteDeepHistoryStore(directory: directory)
        #expect(try await saved.progress(scope: scope)?.phase == .active)
        #expect(try await saved.progress(scope: other)?.phase == .paused(.reconnectTesla))
        #expect(try await saved.progress(scope: elsewhere)?.phase == .paused(.signIn))
    }
}
