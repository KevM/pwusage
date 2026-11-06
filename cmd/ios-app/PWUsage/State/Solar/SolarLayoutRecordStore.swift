import CryptoKit
import Foundation

actor SolarLayoutRecordStore {
    static let shared = SolarLayoutRecordStore()

    private let directory: URL
    private let fileManager: FileManager
    private let activeAccountScopeProvider: @Sendable () -> String?
    private var cache: [SolarForecastSiteScope: SolarLayoutRecord] = [:]
    private var authority: WriteAuthority = .unrestricted
    private var unsynced: [SolarForecastSiteScope: UUID]?
    private var owedReveals: SolarLayoutOwedReveals
    private var onBindingChange: (@Sendable () async -> Void)?
    private var onUploadRead: (@Sendable () async -> Void)?

    /// Who may write account layout records. Checked in the same actor turn as each
    /// write, with no suspension between the check and the synchronous disk commit.
    private enum WriteAuthority {
        /// No session has bound in this process yet: tests and launch-time writes that
        /// precede activation. Their unsynced markers are recovered on activation.
        case unrestricted
        case session(SolarCloudSession, any SolarLayoutSyncing)
        /// Signed out, or cleanup failed: nothing writes until the next activation.
        case closed
    }

    init(
        fileManager: FileManager = .default,
        directory: URL? = nil,
        activeAccountScopeProvider: @escaping @Sendable () -> String? = {
            UserDefaults.standard.string(forKey: PWUsageAppModel.accountScopeDefaultsKey)
        }
    ) {
        self.fileManager = fileManager
        self.activeAccountScopeProvider = activeAccountScopeProvider
        self.directory = directory ?? (fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory).appendingPathComponent("SolarLayout", isDirectory: true)
        owedReveals = SolarLayoutOwedReveals(fileManager: fileManager, recordDirectory: self.directory)
    }

    var hasEngine: Bool {
        guard case .session(let session, _) = authority else { return false }
        return session.hasEngine
    }

    var isWritable: Bool {
        switch authority {
        case .unrestricted: true
        case .session(let session, _): session.isValid
        case .closed: false
        }
    }

    /// Test seam: runs, possibly suspending, at the start of each binding change, so
    /// tests can resume an obsolete change after a replacement. Every ownership check
    /// below therefore follows the suspension.
    func setOnBindingChange(_ handler: (@Sendable () async -> Void)?) {
        onBindingChange = handler
    }

    /// Test seam: runs, possibly suspending, before an outgoing upload reads a record.
    func setOnUploadRead(_ handler: (@Sendable () async -> Void)?) {
        onUploadRead = handler
    }

    func bind(_ session: SolarCloudSession, to sync: any SolarLayoutSyncing) async {
        await notifyBindingChange()
        // A late bind for a session revoked by sign-out must not reopen a closed store.
        guard session.isValid else { return }
        authority = .session(session, sync)
    }

    func close() async {
        await notifyBindingChange()
        authority = .closed
    }

    private func notifyBindingChange() async {
        if let handler = onBindingChange {
            await handler()
        }
    }

    func record(scope: SolarForecastSiteScope) throws -> SolarLayoutRecord? {
        if let record = cache[scope] { return record }
        guard fileManager.fileExists(atPath: fileURL(scope).path) else { return nil }
        let record = try JSONDecoder().decode(SolarLayoutRecord.self, from: Data(contentsOf: fileURL(scope)))
        cache[scope] = record
        return record
    }

    func response(scope: SolarForecastSiteScope, historyEnabled: Bool) throws -> MobileSolarLayoutResponse {
        guard historyEnabled else { return .disabled }
        guard let record = try record(scope: scope) else {
            return .enabled(location: nil, layout: nil, reason: .needsLocation)
        }
        return record.response(historyEnabled: true)
    }

    func setLocation(_ location: SolarHomeLocation, scope: SolarForecastSiteScope, at date: Date = .now) throws {
        try authorizeLocalWrite(scope)
        let rounded = Self.rounded(location)
        var value = try record(scope: scope) ?? SolarLayoutRecord(
            location: nil, locationSetAt: nil, result: nil, detectedAt: nil,
            attemptedAt: nil, detectorVersion: nil, resultLocation: nil)
        if !solarLocationsShareCoordinates(value.location, rounded) {
            value.result = nil
            value.detectedAt = nil
            value.attemptedAt = nil
            value.detectorVersion = nil
            value.resultLocation = nil
        }
        value.location = rounded
        value.locationSetAt = date
        try commitLocal(value, scope: scope)
        if value.result == nil { try? acknowledgeReveal(scope: scope) }
    }

    @discardableResult
    func saveResult(
        _ result: DetectedSolarLayout, scope: SolarForecastSiteScope, for location: SolarHomeLocation, at date: Date
    ) throws -> Bool {
        try authorizeLocalWrite(scope)
        guard var value = try record(scope: scope),
              solarLocationsShareCoordinates(value.location, Self.rounded(location)) else {
            return false
        }
        let hadLayout = Self.showsLayout(value, scope: scope)
        value.result = result
        value.detectedAt = date
        value.attemptedAt = date
        value.detectorVersion = SolarLayoutDetector.version
        value.resultLocation = value.location
        try commitLocal(value, scope: scope)
        updateOwedReveal(hadLayout: hadLayout, record: value, scope: scope)
        return true
    }

    @discardableResult
    func saveFailure(
        scope: SolarForecastSiteScope, for location: SolarHomeLocation, at date: Date
    ) throws -> Bool {
        try authorizeLocalWrite(scope)
        guard var value = try record(scope: scope),
              solarLocationsShareCoordinates(value.location, Self.rounded(location)) else {
            return false
        }
        let failed = DetectedSolarLayout(status: .failed, confidence: nil, reasons: [], planes: [], acClipKw: nil,
                                         historyDays: 0, clearDays: 0, firstDay: nil, lastDay: nil)
        value.result = failed
        value.detectedAt = date
        value.attemptedAt = date
        value.detectorVersion = SolarLayoutDetector.version
        value.resultLocation = value.location
        try commitLocal(value, scope: scope)
        try? acknowledgeReveal(scope: scope)
        return true
    }

    /// Whether the site already had a layout to show before a new result; Debug's Ignore Existing
    /// Layout counts what it hides as none, so a search it reruns can celebrate.
    private static func showsLayout(_ record: SolarLayoutRecord, scope: SolarForecastSiteScope) -> Bool {
        #if DEBUG
            if SiteHistoryDebugSettings.hidesResult(detectedAt: record.detectedAt, scope: scope) { return false }
        #endif
        return record.hasUsableResult
    }

    @discardableResult
    func applyRemoteRecord(
        _ remote: SolarLayoutRecord, scope: SolarForecastSiteScope
    ) throws -> SolarLayoutRemoteApplyOutcome {
        var appliedScopes = [scope]
        let merged = try mergeAndSave(remote, scope: scope)
        if let active = applyToActiveScopeIfNeeded(remote, sourceScope: scope) {
            appliedScopes.append(active)
        }
        return SolarLayoutRemoteApplyOutcome(record: merged, appliedScopes: appliedScopes)
    }

    @discardableResult
    func applyRemoteRecord(
        _ remote: SolarLayoutRecord, scope: SolarForecastSiteScope,
        from source: any SolarLayoutSyncing, engine token: SolarCloudEngineToken
    ) throws -> SolarLayoutRemoteApplyOutcome {
        // Validate at the write boundary so queued work cannot cross a stop, restart or sign-out.
        guard case .session(let session, let sync) = authority, sync === source, session.isCurrent(token)
        else { throw CancellationError() }
        return try applyRemoteRecord(remote, scope: scope)
    }

    func recordForUpload(scope: SolarForecastSiteScope) async throws -> SolarLayoutRecord? {
        if let handler = onUploadRead {
            await handler()
        }
        return try record(scope: scope)
    }

    @discardableResult
    private func mergeAndSave(_ remote: SolarLayoutRecord, scope: SolarForecastSiteScope) throws -> SolarLayoutRecord {
        let local = try record(scope: scope)
        let merged = SolarLayoutCloudMerge.merge(local: local, remote: remote)
        if merged != local {
            try save(merged, scope: scope)
        }
        return merged
    }

    private func applyToActiveScopeIfNeeded(
        _ remote: SolarLayoutRecord, sourceScope: SolarForecastSiteScope
    ) -> SolarForecastSiteScope? {
        guard let activeAccount = activeAccountScopeProvider(),
              !activeAccount.isEmpty,
              activeAccount != sourceScope.accountScopeID else { return nil }
        let activeScope = SolarForecastSiteScope(accountScopeID: activeAccount, siteID: sourceScope.siteID)
        _ = try? mergeAndSave(remote, scope: activeScope)
        return activeScope
    }

    private func authorizeLocalWrite(_ scope: SolarForecastSiteScope) throws {
        switch authority {
        case .unrestricted:
            return
        case .session(let session, _) where session.isValid && session.accountScopeID == scope.accountScopeID:
            return
        case .session, .closed:
            throw CancellationError()
        }
    }

    /// The unsynced marker is written ahead of the record, so termination between the
    /// two leaves at worst a redundant upload, never a saved record nobody uploads. Each
    /// save gets a fresh marker generation, so acknowledging an earlier read of the
    /// markers cannot clear a save that landed after it.
    private func commitLocal(_ value: SolarLayoutRecord, scope: SolarForecastSiteScope) throws {
        var markers = loadUnsynced()
        markers[scope] = UUID()
        try saveUnsynced(markers)
        try save(value, scope: scope)
        // Capture the session in the committing turn; delivery never reads the current one.
        guard case .session(let session, let sync) = authority else { return }
        Task { await sync.recordChanged(scope, session: session) }
    }

    func unsyncedMarkers(for session: SolarCloudSession) -> [SolarForecastSiteScope: UUID] {
        guard isBound(to: session) else { return [:] }
        return loadUnsynced().filter { $0.key.accountScopeID == session.accountScopeID }
    }

    func unsyncedScopes(for session: SolarCloudSession) -> Set<SolarForecastSiteScope> {
        Set(unsyncedMarkers(for: session).keys)
    }

    /// Clears only markers whose generation is unchanged since they were read.
    func acknowledge(_ markers: [SolarForecastSiteScope: UUID], for session: SolarCloudSession) {
        guard isBound(to: session) else { return }
        let remaining = loadUnsynced().filter { markers[$0.key] != $0.value }
        try? saveUnsynced(remaining)
    }

    private func isBound(to session: SolarCloudSession) -> Bool {
        guard case .session(let bound, _) = authority else { return false }
        return bound === session && session.isValid
    }

    /// An unreadable marker file is treated as empty rather than blocking every local
    /// write; the next save rewrites it.
    private func loadUnsynced() -> [SolarForecastSiteScope: UUID] {
        if let unsynced { return unsynced }
        let loaded = (try? Data(contentsOf: unsyncedURL))
            .flatMap { try? JSONDecoder().decode([SolarForecastSiteScope: UUID].self, from: $0) } ?? [:]
        unsynced = loaded
        return loaded
    }

    private func saveUnsynced(_ markers: [SolarForecastSiteScope: UUID]) throws {
        try fileManager.createDirectory(at: unsyncedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(markers).write(
            to: unsyncedURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        unsynced = markers
    }

    /// Beside the record directory so record enumeration sees only records.
    private var unsyncedURL: URL {
        directory.deletingLastPathComponent().appendingPathComponent("\(directory.lastPathComponent)-unsynced.json")
    }

    // MARK: - Owed reveals

    /// Whether this phone found the site's layout and nobody has seen the reveal yet. Kept beside
    /// the records, never in one: iCloud must not carry it to another phone, and a layout iCloud
    /// brings back was never found here.
    func isRevealOwed(scope: SolarForecastSiteScope) throws -> Bool {
        owedReveals.contains(scope)
    }

    func acknowledgeReveal(scope: SolarForecastSiteScope) throws {
        try owedReveals.remove(scope)
    }

    #if DEBUG
        /// Debug's Replay Reveal: owes one for the layout already stored, if there is one.
        func markRevealOwed(scope: SolarForecastSiteScope) throws {
            guard try record(scope: scope)?.hasUsableResult == true else { return }
            try owedReveals.insert(scope)
        }
    #endif

    /// After a local detection: a first usable layout owes a reveal, a result with no layout
    /// cancels one, and improving a layout changes nothing. A lost marker only costs the
    /// celebration, so it never fails the save.
    private func updateOwedReveal(hadLayout: Bool, record: SolarLayoutRecord, scope: SolarForecastSiteScope) {
        if !record.hasUsableResult {
            try? owedReveals.remove(scope)
        } else if !hadLayout {
            try? owedReveals.insert(scope)
        }
    }

    func remove(scope: SolarForecastSiteScope) throws {
        cache.removeValue(forKey: scope)
        try? acknowledgeReveal(scope: scope)
        try removeFile(fileURL(scope))
    }

    func removeAll() throws {
        cache.removeAll()
        unsynced = [:]
        try removeFile(unsyncedURL)
        try owedReveals.removeAll()
        guard fileManager.fileExists(atPath: directory.path) else { return }
        try fileManager.removeItem(at: directory)
    }

    private func save(_ record: SolarLayoutRecord, scope: SolarForecastSiteScope) throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(directoryValues)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
        let url = fileURL(scope)
        try JSONEncoder().encode(record).write(
            to: url,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        // Atomic replacement has committed. Keep memory aligned with disk even if
        // applying protection or backup metadata below fails.
        cache[scope] = record
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        var fileValues = URLResourceValues()
        fileValues.isExcludedFromBackup = true
        var protectedFile = url
        try protectedFile.setResourceValues(fileValues)
    }

    private func removeFile(_ url: URL) throws {
        do { try fileManager.removeItem(at: url) } catch let error as CocoaError where error.code == .fileNoSuchFile {}
    }

    private func fileURL(_ scope: SolarForecastSiteScope) -> URL {
        let key = "\(scope.accountScopeID)|\(scope.siteID)"
        let hash = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(hash).json")
    }

    private static func rounded(_ location: SolarHomeLocation) -> SolarHomeLocation {
        location.rounded
    }
}
