import Testing
@testable import PWUsage

@Suite("Solar Forecast Settings Status Tests")
struct SolarForecastSettingsStatusTests {
    @Test("Unauthorized discovery identifies the invalid key without offering manual IDs")
    func unauthorizedIsNotConnected() {
        let status = SolarForecastSettingsStatus.presentation(
            for: SolarForecastStore.StoreError.discoveryFailed(.unauthorized),
            operation: .discovery,
            hasCredential: true
        )

        #expect(!status.isConnected)
        #expect(!status.allowsManualIDs)
        #expect(status.message == "Solcast rejected this API key. Check or replace it.")
    }

    @Test("Rate limits and local budget exhaustion remain connected with retry guidance")
    func deferredStatusesAreAccurate() {
        let rateLimited = SolarForecastSettingsStatus.presentation(
            for: SolarForecastStore.StoreError.discoveryFailed(.rateLimited),
            operation: .discovery,
            hasCredential: true
        )
        let budget = SolarForecastSettingsStatus.presentation(
            for: SolarForecastStore.StoreError.budgetExhausted,
            operation: .discovery,
            hasCredential: true
        )

        #expect(rateLimited.isConnected)
        #expect(!rateLimited.allowsManualIDs)
        #expect(rateLimited.message.contains("later"))
        #expect(budget.isConnected)
        #expect(!budget.allowsManualIDs)
        #expect(budget.message.contains("device"))
    }

    @Test("Provider failures may offer manual IDs without exposing response details")
    func providerFailureOffersManualFallback() {
        let status = SolarForecastSettingsStatus.presentation(
            for: SolarForecastStore.StoreError.discoveryFailed(.requestFailed),
            operation: .discovery,
            hasCredential: true
        )

        #expect(status.isConnected)
        #expect(status.allowsManualIDs)
        #expect(status.message == "Solcast could not be reached. You can enter Solar System IDs manually or retry discovery.")
    }

    @Test("Connection storage failure never offers discovery fallback")
    func connectionStorageFailureIsClassifiedSeparately() {
        let status = SolarForecastSettingsStatus.presentation(
            for: SolarForecastStore.StoreError.persistenceFailed,
            operation: .connection,
            hasCredential: false
        )

        #expect(!status.isConnected)
        #expect(!status.allowsManualIDs)
        #expect(status.message == "This device could not safely save the Solcast connection. Try again.")
    }

    @Test("Cleanup failure retains connected state and gives retry guidance")
    func cleanupFailureRetainsConnection() {
        let status = SolarForecastSettingsStatus.presentation(
            for: SolarForecastStore.StoreError.cleanupFailed,
            operation: .disconnect,
            hasCredential: true
        )

        #expect(status.isConnected)
        #expect(!status.allowsManualIDs)
        #expect(status.message == "Disconnect could not finish safely. Your connection is still saved. Try again.")
    }
}
