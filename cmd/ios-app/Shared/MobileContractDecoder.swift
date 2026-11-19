import Foundation
import os

enum MobileContractDecoder {
    /// The clock is resolved once, here, and handed to `init(from:)` through `userInfo`. That
    /// makes the freshness rules testable, but it also means a decoder is single-use: build one
    /// per response and never cache it in a `static let`, or every later decode silently judges
    /// freshness against the instant the cached decoder was built.
    static func make(now: @escaping @Sendable () -> Date = { Date() }) -> JSONDecoder {
        let decoder = JSONDecoder()
        if let key = CodingUserInfoKey.pwusageCurrentDate { decoder.userInfo[key] = now() }
        let parser = ContractTimestampParser()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = parser.parse(value) else {
                throw DecodingError.dataCorruptedError(in: container,
                                                       debugDescription: "Invalid ISO-8601 timestamp: \(value)")
            }
            return date
        }
        return decoder
    }
}

extension CodingUserInfoKey {
    /// The clock the decoder was built with, so decode-time freshness rules stay testable.
    /// `CodingUserInfoKey.init(rawValue:)` is failable on this SDK, so the key stays optional
    /// and `MobileContractDecoder.make` simply skips the write if it cannot be formed.
    static let pwusageCurrentDate: CodingUserInfoKey? = CodingUserInfoKey(rawValue: "pwusage.currentDate")
}

extension Decoder {
    /// The clock `MobileContractDecoder.make` was built with, absent when the decoder carried none.
    var injectedCurrentDate: Date? {
        guard let key = CodingUserInfoKey.pwusageCurrentDate else { return nil }
        return userInfo[key] as? Date
    }
}

/// Reuses one pair of ISO-8601 formatters per response decoder while keeping the `@Sendable`
/// `dateDecodingStrategy` closure Swift 6 concurrency-safe.
private final class ContractTimestampParser: Sendable {
    private struct Formatters {
        let fractional: ISO8601DateFormatter
        let standard: ISO8601DateFormatter

        init() {
            fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
        }
    }

    private let lock = OSAllocatedUnfairLock(uncheckedState: Formatters())

    func parse(_ value: String) -> Date? {
        lock.withLockUnchecked { formatters in
            if let date = formatters.fractional.date(from: value) { return date }
            return formatters.standard.date(from: value)
        }
    }
}
