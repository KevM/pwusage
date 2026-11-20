import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Sending the rate plan to Tesla")
struct TeslaSyncModelTests {
    static let previewJSON = """
    {
      "fingerprint": "fp-1",
      "current": {"name": "Tesla plan", "seasons": []},
      "proposed": {
        "name": "Utility plan",
        "seasons": [{
          "name": "All year", "fromMonth": 1, "toMonth": 12,
          "weekdayPeriods": [{
            "touName": "ON_PEAK", "fromHour": 16, "fromMinute": 0, "toHour": 21, "toMinute": 0,
            "buyRate": 0.3, "sellRate": 0.1
          }],
          "weekendPeriods": []
        }],
        "source": "manual",
        "selectionId": 7
      },
      "adjustments": [],
      "problems": [],
      "estimated": false
    }
    """

    static func preview(fingerprint: String = "fp-1", problems: String = "[]") throws -> TeslaSyncPreviewDTO {
        let json = previewJSON
            .replacingOccurrences(of: "\"fp-1\"", with: "\"\(fingerprint)\"")
            .replacingOccurrences(of: "\"problems\": []", with: "\"problems\": \(problems)")
        return try MobileContractDecoder.make().decode(TeslaSyncPreviewDTO.self, from: Data(json.utf8))
    }

    static func result(_ outcome: String, message: String? = nil) throws -> TeslaSyncResultDTO {
        let messageJSON = message.map { ", \"message\": \"\($0)\"" } ?? ""
        let json = "{\"outcome\": \"\(outcome)\"\(messageJSON)}"
        return try MobileContractDecoder.make().decode(TeslaSyncResultDTO.self, from: Data(json.utf8))
    }

    static func timeline(syncAvailable: Bool) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2, siteId: "site-1", timezone: "America/Chicago", currency: "USD", periods: [],
            reattribution: nil,
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil, latestTariffName: nil, latestUpdatedAt: nil,
                activeManualUpdatedAt: nil, differsFromActiveManual: true,
                syncAvailable: syncAvailable, syncUnavailableReason: nil, lastSync: nil
            )
        )
    }

    /// Records every call. Everything runs on the main actor, so no lock is needed.
    @MainActor
    final class Spy {
        var previews = 0
        var commits: [String] = []
        var refreshes = 0
        var previewQueue: [TeslaSyncPreviewDTO] = []
        var previewError: (any Error)?
        var commitResult: TeslaSyncResultDTO?
        var refreshedTimeline = TeslaSyncModelTests.timeline(syncAvailable: false)

        var actions: TeslaSyncActions {
            TeslaSyncActions(
                preview: {
                    self.previews += 1
                    if let error = self.previewError { throw error }
                    if self.previewQueue.isEmpty { return try TeslaSyncModelTests.preview() }
                    return self.previewQueue.removeFirst()
                },
                commit: { fingerprint in
                    self.commits.append(fingerprint)
                    await Task.yield()
                    return try self.commitResult ?? TeslaSyncModelTests.result("confirmed")
                },
                refreshTimeline: {
                    self.refreshes += 1
                    return self.refreshedTimeline
                }
            )
        }
    }

    @Test("Loading shows the review of what would be sent")
    func loadShowsReview() async throws {
        let spy = Spy()
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        guard case .review(let preview) = model.phase else {
            Issue.record("Expected a review, got \(model.phase)")
            return
        }
        #expect(preview.fingerprint == "fp-1")
        #expect(preview.proposed.selectionId == 7)
        #expect(model.canConfirm)
        #expect(spy.commits.isEmpty, "Loading never writes")
    }

    @Test("Loading shows Tesla's unavailable reason and its message")
    func loadShowsUnavailableReason() async throws {
        let spy = Spy()
        spy.previewError = TeslaSyncUnavailability(reason: "no_difference", message: "Tesla already has this plan.")
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        #expect(model.phase == .unavailable(
            TeslaSyncUnavailability(reason: "no_difference", message: "Tesla already has this plan.")
        ))
        #expect(spy.commits.isEmpty)
    }

    @Test("A review with problems cannot be confirmed")
    func problemsBlockConfirm() async throws {
        let spy = Spy()
        spy.previewQueue = [try Self.preview(
            problems: "[{\"code\": \"season_gap\", \"message\": \"December has no season.\"}]"
        )]
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        #expect(!model.canConfirm)
        await model.confirm()
        #expect(spy.commits.isEmpty)
    }

    @Test("Confirming a confirmed write shows that Tesla now has this plan and hands back the timeline")
    func confirmedShowsSuccess() async throws {
        let spy = Spy()
        spy.commitResult = try MobileContractDecoder.make().decode(TeslaSyncResultDTO.self, from: Data("""
        {"outcome": "confirmed", "message": "Tesla now has this plan.", "timeline": \(Self.timelineJSON)}
        """.utf8))
        var handedBack: SiteTariffsTimelineResponse?
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { handedBack = $0 })
        await model.load()
        await model.confirm()
        guard case .finished(let finished) = model.phase else {
            Issue.record("Expected a finished result, got \(model.phase)")
            return
        }
        #expect(finished.outcome == "confirmed")
        #expect(TeslaSyncCopy.resultMessage(finished.outcome, message: finished.message) == "Tesla now has this plan.")
        #expect(handedBack != nil, "The returned timeline reaches the owner")
        #expect(spy.refreshes == 0, "A returned timeline is used without a second fetch")
        #expect(spy.commits == ["fp-1"])
    }

    @Test("An unconfirmed write says Tesla hasn't confirmed yet, and refetches the timeline")
    func unconfirmedRefetches() async throws {
        let spy = Spy()
        spy.commitResult = try Self.result(
            "unconfirmed", message: "Sent to Tesla. It hasn't confirmed yet; PWUsage will check again."
        )
        var handedBack: SiteTariffsTimelineResponse?
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { handedBack = $0 })
        await model.load()
        await model.confirm()
        guard case .finished(let finished) = model.phase else {
            Issue.record("Expected a finished result, got \(model.phase)")
            return
        }
        #expect(
            TeslaSyncCopy.resultMessage(finished.outcome, message: finished.message)
                == "Sent to Tesla. It hasn't confirmed yet; PWUsage will check again."
        )
        #expect(spy.refreshes == 1)
        #expect(handedBack != nil)
    }

    @Test("A conflict reloads the preview silently and writes nothing more")
    func conflictReloadsPreview() async throws {
        let spy = Spy()
        spy.previewQueue = [
            try Self.preview(fingerprint: "fp-1"),
            try Self.preview(fingerprint: "fp-2")
        ]
        spy.commitResult = try Self.result("conflict", message: "Tesla or your rate plan changed.")
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        await model.confirm()
        #expect(spy.previews == 2)
        #expect(spy.commits == ["fp-1"], "No automatic second write")
        guard case .review(let fresh) = model.phase else {
            Issue.record("Expected the fresh review, got \(model.phase)")
            return
        }
        #expect(fresh.fingerprint == "fp-2")
    }

    @Test("A rejection shows Tesla's own words and that nothing changed")
    func rejectedIncludesTeslaText() async throws {
        let spy = Spy()
        spy.commitResult = try Self.result("rejected", message: "Battery mode is locked")
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        await model.confirm()
        guard case .finished(let finished) = model.phase else {
            Issue.record("Expected a finished result, got \(model.phase)")
            return
        }
        #expect(
            TeslaSyncCopy.resultMessage(finished.outcome, message: finished.message)
                == "Tesla didn't accept this plan: Battery mode is locked. Nothing changed on your Powerwall."
        )
        #expect(spy.refreshes == 0, "A rejected write leaves the timeline alone")
    }

    @Test("A second confirm while sending is ignored, so Tesla is written once")
    func doubleConfirmSendsOnce() async throws {
        let spy = Spy()
        let model = TeslaSyncModel(actions: spy.actions, onTimeline: { _ in })
        await model.load()
        async let first: Void = model.confirm()
        await model.confirm()
        await first
        #expect(spy.commits.count == 1)
    }

    @Test("Only a plan that covers today from PWUsage's own actual plan prompts a sync after applying")
    func postApplyPromptRules() throws {
        let covering = TariffSelectionRequest(
            scope: .actual, candidate: .publicPlan(label: "abc"), effectiveFrom: "2000-01-01", effectiveTo: nil
        )
        let reference = TariffSelectionRequest(
            scope: .reference, candidate: .publicPlan(label: "abc"), effectiveFrom: "2000-01-01", effectiveTo: nil
        )
        let past = TariffSelectionRequest(
            scope: .actual, candidate: .publicPlan(label: "abc"),
            effectiveFrom: "2000-01-01", effectiveTo: "2000-02-01"
        )
        let ready = Self.timeline(syncAvailable: true)
        #expect(TeslaSyncPrompt.offers(afterApplying: covering, timeline: ready))
        #expect(!TeslaSyncPrompt.offers(afterApplying: reference, timeline: ready))
        #expect(!TeslaSyncPrompt.offers(afterApplying: past, timeline: ready))
        #expect(!TeslaSyncPrompt.offers(afterApplying: covering, timeline: Self.timeline(syncAvailable: false)))
    }

    static let timelineJSON = """
    {"version": 2, "siteId": "site-1", "timezone": "America/Chicago", "currency": "USD", "periods": [],
     "reattribution": null,
     "teslaSync": {"latestTariffId": null, "latestTariffName": null, "latestUpdatedAt": null,
       "activeManualUpdatedAt": null, "differsFromActiveManual": false, "syncAvailable": false,
       "syncUnavailableReason": null, "lastSync": null}}
    """
}
