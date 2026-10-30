import Foundation
@testable import PWUsage
import Testing

@Suite("Automatic solar forecast settings copy and invitation")
struct SolarAutomaticSettingsTests {
    private static let forecastSolar = ForecastSolarProvider().descriptor
    private static let solcast = SolcastForecastProvider(store: FakeSolcastStore()).descriptor
    private static let device = SolarHomeLocation(latitude: 1, longitude: 2, source: .device)

    private static func layout(_ planes: [SolarLayoutPlane], confidence: SolarLayoutConfidence = .high) -> SolarLayout {
        SolarLayout(planes: planes, acClipKw: nil, confidence: confidence, detectedAt: nil)
    }

    @Test("Two faces, the source and the confidence are summarised")
    func twoFaces() {
        let response = MobileSolarLayoutResponse.enabled(
            location: Self.device,
            layout: Self.layout([
                SolarLayoutPlane(azimuth: 90, tilt: 18, dcKwp: 5.6), SolarLayoutPlane(
                    azimuth: 270,
                    tilt: 18,
                    dcKwp: 4.0
                )]),
            reason: nil
        )
        let lines = SolarForecastSettingsStatus.automaticSummary(response: response, source: Self.forecastSolar)
        #expect(lines == [
            "Automatic forecast from Forecast.Solar",
            "2 panel faces: east-facing about 5.6 kW, west-facing about 4 kW",
            "High confidence"])
    }

    @Test("One southwest face with medium confidence, read-only under Solcast")
    func oneFaceUnderSolcast() {
        let response = MobileSolarLayoutResponse.enabled(
            location: Self.device,
            layout: Self.layout([SolarLayoutPlane(azimuth: 205, tilt: 20, dcKwp: 5.2)], confidence: .medium),
            reason: nil
        )
        let lines = SolarForecastSettingsStatus.automaticSummary(response: response, source: Self.solcast)
        #expect(lines == ["Forecast from Solcast", "1 panel face: southwest-facing about 5.2 kW", "Medium confidence"])
    }

    @Test("Every reason has its sentence; disabled says nothing", arguments: [
        (MobileSolarLayoutReason.notEnoughHistory, "We need about 6 weeks of solar history first"),
        (.lowConfidence, "Your production doesn't match a clear panel layout yet"),
        (.pending, "Waiting for your panel layout to be detected."),
        (.needsLocation, "Share your home location so we can work out which way your panels face.")
    ])
    func reasons(reason: MobileSolarLayoutReason, sentence: String) {
        let response = MobileSolarLayoutResponse.enabled(location: nil, layout: nil, reason: reason)
        #expect(SolarForecastSettingsStatus.automaticSummary(response: response, source: nil) == [sentence])
        #expect(SolarForecastSettingsStatus.automaticSummary(response: .disabled, source: nil).isEmpty)
    }

    @Test("An estimated location is called approximate")
    func estimated() {
        let response = MobileSolarLayoutResponse.enabled(
            location: SolarHomeLocation(latitude: 1, longitude: 2, source: .estimated), layout: nil, reason: .pending
        )
        let lines = SolarForecastSettingsStatus.automaticSummary(response: response, source: nil)
        #expect(lines.contains("Your location is approximate"))
    }

    @Test("The invitation is beta-only, skips Solcast users and names the estimated case")
    func invitationKind() {
        let missing = MobileSolarLayoutResponse.enabled(location: nil, layout: nil, reason: .needsLocation)
        let estimated = MobileSolarLayoutResponse.enabled(
            location: SolarHomeLocation(latitude: 1, longitude: 2, source: .estimated), layout: nil, reason: .pending
        )
        let device = MobileSolarLayoutResponse.enabled(location: Self.device, layout: nil, reason: .pending)
        #expect(SolarLocationInvitation.kind(status: missing, hasSolcast: false) == .missing)
        #expect(SolarLocationInvitation.kind(status: estimated, hasSolcast: false) == .estimated)
        #expect(SolarLocationInvitation.kind(status: device, hasSolcast: false) == nil)
        #expect(SolarLocationInvitation.kind(status: .disabled, hasSolcast: false) == nil)
        #expect(SolarLocationInvitation.kind(status: nil, hasSolcast: false) == nil)
        #expect(SolarLocationInvitation.kind(status: missing, hasSolcast: true) == nil)
        #expect(SolarLocationInvitation.Kind.estimated.message
            == "Your forecast uses an approximate location. Share your exact home location for a better one.")
    }

    @Test("A dismissed invitation stays dismissed after relaunch, per account and site")
    func dismissalPersists() throws {
        let suite = "solar-invitation-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        SolarLocationInvitation.Dismissals(defaults: defaults).dismiss(scope)
        let relaunched = SolarLocationInvitation.Dismissals(defaults: defaults)
        #expect(relaunched.isDismissed(scope))
        #expect(!relaunched.isDismissed(SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-b")))
    }
}
