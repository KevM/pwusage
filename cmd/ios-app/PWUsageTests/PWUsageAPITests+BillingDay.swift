import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
    @Test("Setting the billing day posts the site and day and decodes the confirmation")
    func setBillingDayTransport() async throws {
        var recorded: (URLRequest, Data)?
        StubURLProtocol.requestHandler = { request in
            recorded = (request, try Self.bodyData(from: request))
            let json = #"{"billingDay":31,"billingDayConfirmed":true}"#
            return (try Self.fillResponse(request, status: 200), Data(json.utf8))
        }
        let saved = try await api.setBillingDay(siteID: "site-1", day: 31)
        #expect(saved == MobileBillingDay(billingDay: 31, billingDayConfirmed: true))

        let (request, body) = try #require(recorded)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/mobile/billing-day")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let sent = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(sent["siteId"] as? String == "site-1")
        #expect(sent["day"] as? Int == 31)
    }

    @Test("Setting the billing day maps a revoked session to sign-in required")
    func setBillingDayUnauthorized() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 401), Data(#"{"error":"Unauthorized"}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.signInRequired) {
            _ = try await api.setBillingDay(siteID: "site-1", day: 5)
        }
    }

    @Test("Setting the billing day rejects a day the server cannot take before sending anything")
    func setBillingDayRejectsInvalidDay() async throws {
        StubURLProtocol.requestHandler = { _ in
            Issue.record("An invalid day must not reach the network")
            throw URLError(.badServerResponse)
        }
        for day in [0, 32] {
            await #expect(throws: PWUsageAPIError.invalidResponse) {
                _ = try await api.setBillingDay(siteID: "site-1", day: day)
            }
        }
    }
}
