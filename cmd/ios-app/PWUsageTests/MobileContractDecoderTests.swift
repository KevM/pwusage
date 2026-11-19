import Foundation
@testable import PWUsage
import Testing

@Suite("Mobile contract decoder")
struct MobileContractDecoderTests {
    @Test("Parses fractional seconds, whole seconds, and timezone offsets in one response")
    func parsesSupportedTimestampFormats() throws {
        let json = """
        [
            "2026-09-23T12:34:56.123Z",
            "2026-09-23T12:34:56Z",
            "2026-09-23T07:34:56-05:00",
            "2026-09-23T18:04:56.500+05:30"
        ]
        """
        let dates = try MobileContractDecoder.make().decode([Date].self, from: Data(json.utf8))
        #expect(dates.count == 4)
        #expect(abs(dates[0].timeIntervalSince1970 - 1_790_166_896.123) < 0.001)
        #expect(abs(dates[1].timeIntervalSince1970 - 1_790_166_896.0) < 0.001)
        #expect(abs(dates[2].timeIntervalSince1970 - 1_790_166_896.0) < 0.001)
        #expect(abs(dates[3].timeIntervalSince1970 - 1_790_166_896.5) < 0.001)
    }

    @Test("Throws DecodingError.dataCorrupted for invalid timestamps")
    func throwsDataCorruptedForInvalidTimestamp() {
        let json = #"["not-a-timestamp"]"#
        do {
            _ = try MobileContractDecoder.make().decode([Date].self, from: Data(json.utf8))
            Issue.record("Expected DecodingError.dataCorrupted")
        } catch DecodingError.dataCorrupted(let context) {
            #expect(context.debugDescription == "Invalid ISO-8601 timestamp: not-a-timestamp")
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Each decoder captures a fresh injected clock")
    func freshDecoderCapturesInjectedClock() {
        let firstInstant = Date(timeIntervalSince1970: 1_700_000_000)
        let secondInstant = Date(timeIntervalSince1970: 1_700_000_120)
        let firstDecoder = MobileContractDecoder.make(now: { firstInstant })
        let secondDecoder = MobileContractDecoder.make(now: { secondInstant })
        let key = CodingUserInfoKey.pwusageCurrentDate
        #expect(key.flatMap { firstDecoder.userInfo[$0] as? Date } == firstInstant)
        #expect(key.flatMap { secondDecoder.userInfo[$0] as? Date } == secondInstant)
    }

    @Test("Decoder date strategy is safe under concurrent decoding")
    func concurrentDecodingIsSafe() async throws {
        let decoder = MobileContractDecoder.make()
        let payload = Data(#"["2026-09-23T12:34:56.123Z","2026-09-23T12:34:56Z"]"#.utf8)
        let results = try await withThrowingTaskGroup(of: [Date].self) { group in
            for _ in 0 ..< 8 {
                group.addTask {
                    try decoder.decode([Date].self, from: payload)
                }
            }
            var decoded: [[Date]] = []
            for try await item in group {
                decoded.append(item)
            }
            return decoded
        }
        #expect(results.count == 8)
        #expect(results.allSatisfy { $0.count == 2 })
    }
}
