import Foundation
@testable import PWUsageCore
import Testing

@Suite("Tesla Sync response contracts")
struct TeslaSyncContractTests {
    @Test("Preview decodes the proposed plan and the rate Tesla will store")
    func decodesPreview() throws {
        let json = """
        {
          "fingerprint": "fp-1",
          "current": {"name": "Tesla plan", "seasons": []},
          "proposed": {"name": "Utility plan", "seasons": [], "source": "manual", "selectionId": 7},
          "adjustments": [
            {"season": "Winter", "period": "ON_PEAK", "side": "buy",
             "from": 0.2, "to": 0.25, "reason": "raised_to_sell"}
          ],
          "problems": [{"code": "season_gap", "message": "December has no season."}],
          "estimated": false
        }
        """
        let preview = try JSONDecoder().decode(TeslaSyncPreviewDTO.self, from: Data(json.utf8))

        #expect(preview.fingerprint == "fp-1")
        #expect(preview.proposed.selectionId == 7)
        let adjustment = try #require(preview.adjustments.first)
        #expect(adjustment.from == 0.2)
        #expect(adjustment.stored == 0.25)
        #expect(adjustment.period == .onPeak)
        let problem = try #require(preview.problems.first)
        #expect(problem.code == "season_gap")
        #expect(problem.season == nil)
        #expect(problem.period == nil)
    }

    @Test("Commit can omit its timeline")
    func decodesCommitWithoutTimeline() throws {
        let json = #"{"outcome":"rejected","message":"Battery mode is locked"}"#
        let result = try JSONDecoder().decode(TeslaSyncResultDTO.self, from: Data(json.utf8))
        #expect(result.outcome == "rejected")
        #expect(result.message == "Battery mode is locked")
        #expect(result.timeline == nil)
    }
}
