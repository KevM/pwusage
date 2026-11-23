import Foundation
@testable import PWUsageCore
import Testing

@Suite("Rate plan wire contracts")
struct RatePlanWireContractTests {
    @Test("Decodes the rate plan history response")
    func decodesRateHistoryResponse() throws {
        let plan = """
        {"name": "Residential TOU", "startDate": "2024-03-01", "kind": "time_of_use", "isDefault": false,
         "closest": true, "lowRate": 0.11, "highRate": 0.32,
         "peakWindows": [{"label": "4-9 PM", "fromHour": 16, "toHour": 21},
                         {"label": "5-8 PM", "fromHour": 17, "toHour": 20}],
         "closestWindow": "4-9 PM", "fixedLabel": null}
        """
        let fixed = """
        {"name": "Residential Flat", "startDate": "2024-01-01", "kind": "fixed", "isDefault": true,
         "closest": false, "lowRate": 0.2, "highRate": 0.2, "peakWindows": [],
         "closestWindow": null, "fixedLabel": "abc123"}
        """
        let json = """
        {"utilityName": "Demo Electric", "historyStart": "2023-11-14", "fillThrough": null,
         "teslaShape": "time_of_use", "current": [\(plan)],
         "years": [{"year": 2024, "askDate": "2024-06-01", "plans": [\(plan), \(fixed)]}]}
        """
        let decoded = try JSONDecoder().decode(RatePlanHistoryDTO.self, from: Data(json.utf8))

        #expect(decoded.utilityName == "Demo Electric")
        #expect(decoded.fillThrough == nil)
        #expect(decoded.teslaShape == .timeOfUse)
        #expect(decoded.current.first?.peakWindows.map(\.label) == ["4-9 PM", "5-8 PM"])
        #expect(decoded.current.first?.closestWindow == "4-9 PM")
        #expect(decoded.years.first?.year == 2024)
        #expect(decoded.years.first?.plans.last?.kind == .fixed)
        #expect(decoded.years.first?.plans.last?.fixedLabel == "abc123")
        #expect(decoded.years.first?.plans.last?.id == "abc123")
        #expect(decoded.years.first?.plans.first?.id == "4-9 PM")
    }

    @Test("Encodes an open period with a null to")
    func encodesOpenPeriodWithNullTo() throws {
        let data = try JSONEncoder().encode([
            RatePlanHistoryPeriod(label: "abc", from: "2024-01-01", to: nil),
            RatePlanHistoryPeriod(label: "def", from: "2023-01-01", to: "2023-12-31")
        ])
        let json = try #require(String(data: data, encoding: .utf8))

        #expect(json.contains("\"to\":null"))
        #expect(json.contains("\"to\":\"2023-12-31\""))
    }

    @Test("Encodes a missing component as an explicit null")
    func encodesSystemCostsWriteRequest() throws {
        let request = SystemCostsWriteRequest(
            solar: SystemCostDTO(installDate: "2024-03-04", price: 16_100, taxCreditPercent: nil, incentives: 0),
            powerwall: nil
        )
        let encoded = try JSONEncoder().encode(request)
        let text = try #require(String(data: encoded, encoding: .utf8))

        #expect(text.contains("\"powerwall\":null"))
        #expect(text.contains("\"taxCreditPercent\":null"))
        #expect(text.contains("\"installDate\":\"2024-03-04\""))
    }

    @Test("Selection requests always send explicit dates, with null meaning ongoing")
    func encodesSelectionRequests() throws {
        let request = TariffSelectionRequest(
            scope: .actual, candidate: .publicPlan(label: "abc123"), effectiveFrom: "2025-03-01", effectiveTo: nil
        )
        let commit = TariffSelectionCommit(request: request, expectedReviewHash: "hash-1", verifiedAgainstBill: false)
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(commit)) as? [String: Any])
        #expect(Set(object.keys) == [
            "scope", "candidate", "effectiveFrom", "effectiveTo", "expectedReviewHash", "verifiedAgainstBill"
        ])
        #expect(object["effectiveTo"] is NSNull)
        #expect(object["verifiedAgainstBill"] as? Bool == false)
        #expect(object["candidate"] as? [String: String] == ["kind": "public", "label": "abc123"])

        let restore = try JSONEncoder().encode(TariffSelectionCandidate.restoreTesla(originalSelectionID: 9))
        let restoreObject = try JSONSerialization.jsonObject(with: restore) as? [String: AnyHashable]
        #expect(restoreObject == ["kind": "restore_tesla", "originalSelectionId": 9])
    }

    private func json(_ period: RatePlanHistoryPeriod) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try #require(String(data: encoder.encode(period), encoding: .utf8))
    }

    @Test func nilFixedOmitsTheKey() throws {
        let text = try json(RatePlanHistoryPeriod(label: "L", from: "2024-01-01", to: nil))
        #expect(text == #"{"from":"2024-01-01","label":"L","to":null}"#)
    }

    @Test func publicChoiceEncodesOnlyItsLabel() throws {
        let period = RatePlanHistoryPeriod(
            label: "L", from: "2024-01-01", to: "2024-12-31",
            fixed: .publicPlan(label: "FIX", name: "Residential Rg 1", buyRate: 0.18)
        )
        #expect(try json(period) == #"{"fixed":{"label":"FIX"},"from":"2024-01-01","label":"L","to":"2024-12-31"}"#)
    }

    @Test func manualChoiceEncodesNameAndRates() throws {
        let period = RatePlanHistoryPeriod(
            label: "L", from: "2024-01-01", to: nil,
            fixed: .manual(name: "My rate", buyRate: 0.2, sellRate: 0.05)
        )
        #expect(try json(period)
            == #"{"fixed":{"buyRate":0.2,"name":"My rate","sellRate":0.05},"from":"2024-01-01","label":"L","to":null}"#)
    }
}
