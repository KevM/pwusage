import Foundation
@testable import PWUsageCore
import Testing

@Suite("Rate plan review responses")
struct RatePlanResponseContractTests {
    @Test("Decodes a review with restoration provenance and tolerates new note kinds")
    func decodesPreview() throws {
        let preview = try decode(TariffSelectionPreviewResponse.self, RatePlanResponseFixture.previewJSON)
        #expect(preview.reviewHash == "hash-1")
        #expect(preview.approximationNotes.map(\.kind) == [.tierBlended, .daySpecificSchedule, .other])
        let interval = try #require(preview.affectedIntervals.first)
        #expect(interval.kind == .replace)
        #expect(interval.before?.source == .tesla)
        #expect(interval.after?.exportRateProvenance == .netMetering)
        guard case .preservesTeslaOriginal(let original) = interval.restoration else {
            Issue.record("Expected the Tesla original to be preserved")
            return
        }
        #expect(original.tariffId == 17)
    }

    @Test("Rejects unknown Tesla restoration status")
    func rejectsUnknownRestorationStatus() {
        #expect(throws: DecodingError.self) {
            try decode(TariffIntervalRestorationProvenance.self, #"{"status":"new_status"}"#)
        }
    }

    @Test("Decodes AI handoff export and nested review")
    func decodesAiHandoffPreview() throws {
        let exported = try decode(
            TariffAiHandoffExportResponse.self,
            ##"{"markdown":"# Prompt","filename":"pwusage-rate-plan-check.md"}"##
        )
        #expect(exported.markdown == "# Prompt")
        #expect(exported.filename == "pwusage-rate-plan-check.md")

        let batch = try decode(TariffAiHandoffPreviewResponse.self, RatePlanResponseFixture.batchPreviewJSON)
        #expect(batch.reviewHash == "batch-hash-1")
        #expect(batch.hasChanges)
        #expect(batch.actualPreviews.map(\.reviewHash) == ["hash-1"])
        #expect(batch.unchangedReferenceCount == 1)
    }

    @Test("Decodes distinct single and batch commit responses")
    func decodesCommits() throws {
        let common = """
        "selectionIds": [7], "tariffIds": [17], "unchanged": false,
        "reattributionRange": {"fromDate":"2025-03-01","toDate":null},
        "timeline": {
          "version":2,"siteId":"site-1","timezone":"America/Chicago","currency":"USD","periods":[],
          "teslaSync":{"differsFromActiveManual":false,"syncAvailable":false}
        }
        """
        let single = try decode(TariffSelectionCommitResponse.self, """
        {"createdNewTariffVersion":true,\(common)}
        """)
        #expect(single.createdNewTariffVersion)
        #expect(single.reattributionRange?.fromDate == "2025-03-01")
        #expect(single.timeline.siteId == "site-1")

        let batch = try decode(TariffAiHandoffCommitResponse.self, """
        {"appliedActualCount":1,"appliedReferenceCount":0,\(common)}
        """)
        #expect(batch.appliedActualCount == 1)
        #expect(batch.appliedReferenceCount == 0)
        #expect(batch.selectionIds == [7])
        #expect(batch.timeline.siteId == "site-1")
    }

    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
}
