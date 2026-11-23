import Foundation

/// How the solar forecast enhancement stands on this device.
public enum SolarForecastEnhancementState: Equatable, Sendable {
    case basic
    case loadingWithBasic
    case enhanced
    case failedWithBasic
    case disconnectedBasic
}

/// Whether the user has finished setting forecasting up on this device. Kept
/// apart from `SolarForecastEnhancementState` so the UI can stay silent when no
/// key exists and explain itself when one does.
public enum SolarForecastConnectionState: Equatable, Sendable {
    /// The device hasn't read its Solcast setup yet (at launch or after a site switch).
    case checking
    case notConnected
    case awaitingArraySelection
    case ready
}

/// Why the optional enhancement is not showing, when the connection itself is
/// healthy. Without this every failure collapsed into one sentence that named the
/// forecast, even when our own planning context was the missing piece.
public enum SolarForecastUnavailableReason: Equatable, Sendable {
    case contextUnavailable
    /// The server has history, but too few of the most recent days are complete
    /// to build a household profile.
    case insufficientHistory
    /// The server has history, but its timestamps never line up with the site's
    /// local five-minute grid, so no day can be counted.
    case timestampMisaligned
    /// The request itself was rejected, so nothing is known about the profile.
    case requestFailed
    /// This device's clock put the server's timestamp outside the age window, so
    /// the payload reads as stale or future-dated. Fixable on the device.
    case contextInvalid
    /// The server answered, but the payload failed contract validation for a reason
    /// no clock change can fix — wrong units, unknown timezone, bad history bounds.
    case contextMalformed
    /// The server does not have this route, so it predates the app build.
    case serverOutdated
    case forecastNotUsable
    case billUnavailable
    case siteMismatch
}
