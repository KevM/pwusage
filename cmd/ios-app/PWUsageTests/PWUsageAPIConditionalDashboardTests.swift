import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
    @Test("A conditional summary reuses observed times and accepts the new import outcome")
    func conditionalSummaryTransport() async throws {
        let json = Self.liveFixture(siteID: "site-1").replacingOccurrences(
            of: #""version":1"#,
            with: #""version":1,"historyRevision":"day-revision","historyRefresh":{"status":"pending"}"#
        )
        let cached = try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
        StubURLProtocol.requestHandler = { request in
            let url = try #require(request.url)
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
            #expect(query?.contains(URLQueryItem(name: "historyCheck", value: "1")) == true)
            #expect(query?.contains(URLQueryItem(name: "knownHistoryRevision", value: "day-revision")) == true)
            let response = try #require(HTTPURLResponse(
                url: url, statusCode: 304, httpVersion: nil, headerFields: ["X-PWUsage-History-Refresh": "current"]
            ))
            return (response, Data())
        }

        let response = try await api.fetchLive(siteID: "site-1", refresh: false, historyCheck: true, reusing: cached)

        #expect(response.sources == cached.sources)
        #expect(response.today == cached.today)
        #expect(response.historyRefresh?.status == .current)
    }

    @Test("A conditional bill reuses the matching cached calculation")
    func conditionalBillTransport() async throws {
        let json = """
        {"version":1,"revision":"bill-revision",
         "site":{"id":"site-1","name":"Home","timezone":"UTC"},
         "currentBill":{"estimatedCost":42,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z",
                        "cycleEnd":"2026-10-01T00:00:00Z","periods":[]},
         "sources":{"calculatedAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}
        """
        let cached = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
        StubURLProtocol.requestHandler = { request in
            let url = try #require(request.url)
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
            #expect(query?.contains(URLQueryItem(name: "knownRevision", value: "bill-revision")) == true)
            return (try Self.response(request, status: 304), Data())
        }

        let response = try await api.fetchBill(siteID: "site-1", reusing: cached)

        #expect(response == cached)
    }
}
