import Foundation
@testable import PWUsageCore

/// The app's bundled country outlines, read from the repo so the package ships no copy of the file.
enum CountryBoundariesFixture {
    /// `cmd/ios-app/PWUsage/Resources/country-boundaries.bin`, five folders above this file.
    static let url: URL = (0 ..< 5).reduce(URL(fileURLWithPath: #filePath).deletingLastPathComponent()) { url, _ in
        url.deletingLastPathComponent()
    }
    .appendingPathComponent("PWUsage/Resources/country-boundaries.bin")

    static let resolver: SiteCountryResolver? = (try? CountryBoundaries(
        data: Data(contentsOf: url, options: .mappedIfSafe)
    )).map(SiteCountryResolver.init)
}
