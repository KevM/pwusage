import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
    @Test("A preview 409 carries Tesla's reason and message as an unavailability")
    func teslaSyncPreviewConflictDecodesReason() async throws {
        var seen: URLRequest?
        StubURLProtocol.requestHandler = { request in
            seen = request
            let json = #"{"error":"unavailable", "reason":"needs_reauth", "#
                + #""message":"Reconnect Tesla to sync this plan."}"#
            return (try Self.fillResponse(request, status: 409), Data(json.utf8))
        }
        await #expect(throws: TeslaSyncUnavailability(
            reason: "needs_reauth", message: "Reconnect Tesla to sync this plan."
        )) {
            _ = try await api.previewTeslaSync(siteID: "site-1")
        }
        let request = try #require(seen)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/site/site-1/tariffs/tesla-sync/preview")
    }

    @Test("A commit answer decodes its outcome and message, and posts the reviewed fingerprint")
    func teslaSyncCommitDecodesOutcome() async throws {
        var body: [String: Any]?
        StubURLProtocol.requestHandler = { request in
            body = try JSONSerialization.jsonObject(with: Self.bodyData(from: request)) as? [String: Any]
            let json = #"{"outcome":"rejected","message":"Battery mode is locked"}"#
            return (try Self.fillResponse(request, status: 200), Data(json.utf8))
        }
        let result = try await api.commitTeslaSync(siteID: "site-1", fingerprint: "fp-1")
        #expect(result.outcome == "rejected")
        #expect(result.message == "Battery mode is locked")
        #expect(result.timeline == nil)
        #expect(body?["fingerprint"] as? String == "fp-1")
    }
}
