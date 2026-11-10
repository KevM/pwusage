import Foundation
import Observation

/// Edits the screens one Trmnl device rotates through. Changes save themselves: edits wait for a quiet
/// moment, then go up together, and adding, deleting or moving a screen saves at once. Each screen shows a
/// live preview of its own settings; previews wait for edits to go quiet too, since each one is a server
/// request, and are kept by settings so undoing a change costs nothing.
@MainActor
@Observable
final class TrmnlScreensEditorModel {
    enum Load: Equatable {
        case loading
        case ready
        case failed
    }

    enum Save: Equatable {
        /// Nothing to report: untouched, or edited and waiting for the quiet moment.
        case idle
        case saving
        case saved
        case failed
    }

    let device: TrmnlDevice

    private(set) var loadState = Load.loading
    private(set) var saveState = Save.idle
    private(set) var screens: [TrmnlManagedScreen] = []
    private(set) var selectedIndex = 0

    private var saved: [TrmnlManagedScreen] = []
    private var documents: [TrmnlComponentConfig: String] = [:]
    private var failed: Set<TrmnlComponentConfig> = []
    /// The last document each screen showed, kept while an edit's preview is on its way.
    private var shown: [String: String] = [:]
    private var pendingPreview: Task<Void, Never>?
    private var pendingSave: Task<Void, Never>?
    /// The saves in flight; edits made meanwhile are picked up by the same run.
    private var saveRun: Task<Bool, Never>?

    private let siteID: String
    private let api: any MobileTrmnlAPI
    private let previewDelay: Duration
    private let saveDelay: Duration
    private let makeScreenID: () -> String

    init(
        device: TrmnlDevice, siteID: String, api: any MobileTrmnlAPI,
        previewDelay: Duration = .milliseconds(500), saveDelay: Duration = .milliseconds(1500),
        makeScreenID: @escaping () -> String = { "screen-\(Int(Date().timeIntervalSince1970 * 1000))" }
    ) {
        self.device = device
        self.siteID = siteID
        self.api = api
        self.previewDelay = previewDelay
        self.saveDelay = saveDelay
        self.makeScreenID = makeScreenID
    }

    var hasUnsavedChanges: Bool {
        screens.map { [$0.id: $0.componentConfig] } != saved.map { [$0.id: $0.componentConfig] }
    }

    var canAddScreen: Bool { screens.count < TrmnlManagedScreen.maxScreens }
    var canDeleteScreen: Bool { screens.count > 1 }

    func canMoveSelectedScreen(by offset: Int) -> Bool {
        screens.indices.contains(selectedIndex + offset)
    }

    /// The preview for the screen at `index`, as its settings are now. The last one it showed stays up
    /// while a newer one is on its way.
    func preview(forScreenAt index: Int) -> TrmnlPreviewState {
        guard screens.indices.contains(index) else { return .loading }
        let screen = screens[index]
        if let document = documents[screen.componentConfig] { return .ready(document: document) }
        if failed.contains(screen.componentConfig) { return .unavailable }
        return shown[screen.id].map { .ready(document: $0) } ?? .loading
    }

    // MARK: Loading

    /// Opens on the screen the device is showing now.
    func load() async {
        do {
            let loaded = try await api.fetchTrmnlScreens(uuid: device.uuid)
            screens = Self.numbered(loaded)
            saved = screens
            selectedIndex = min(device.screen.index, screens.count - 1)
            loadState = .ready
            previewSelectedScreen()
        } catch {
            guard !Task.isCancelled else { return }
            loadState = .failed
        }
    }

    // MARK: Editing

    func select(_ index: Int) {
        guard screens.indices.contains(index) else { return }
        selectedIndex = index
        previewSelectedScreen()
    }

    /// Changes the selected screen's settings.
    func update(_ change: (inout TrmnlComponentConfig) -> Void) {
        guard screens.indices.contains(selectedIndex) else { return }
        change(&screens[selectedIndex].componentConfig)
        saveState = .idle
        schedulePreview()
        scheduleSave()
    }

    func addScreen() {
        guard canAddScreen else { return }
        screens.append(TrmnlManagedScreen(id: makeScreenID(), name: "", componentConfig: .newScreen))
        screens = Self.numbered(screens)
        selectedIndex = screens.count - 1
        saveState = .idle
        previewSelectedScreen()
        saveNow()
    }

    func deleteSelectedScreen() {
        guard canDeleteScreen else { return }
        screens.remove(at: selectedIndex)
        screens = Self.numbered(screens)
        selectedIndex = min(selectedIndex, screens.count - 1)
        saveState = .idle
        previewSelectedScreen()
        saveNow()
    }

    /// Moves the selected screen earlier (-1) or later (+1) in the rotation.
    func moveSelectedScreen(by offset: Int) {
        guard canMoveSelectedScreen(by: offset) else { return }
        screens.swapAt(selectedIndex, selectedIndex + offset)
        screens = Self.numbered(screens)
        selectedIndex += offset
        saveState = .idle
        saveNow()
    }

    // MARK: Saving

    /// Saves what is waiting, without the quiet moment: on leaving, or to retry after a failure. Returns
    /// true when the server has everything, or when there was nothing to save.
    func flush() async -> Bool {
        pendingSave?.cancel()
        return await save()
    }

    /// Saves the draft, or joins the save already under way. Returns true when the server has it all.
    func save() async -> Bool {
        if let saveRun { return await saveRun.value }
        guard hasUnsavedChanges else { return true }
        let run = Task { await runSaves() }
        saveRun = run
        return await run.value
    }

    private func scheduleSave() {
        pendingSave?.cancel()
        pendingSave = Task { [saveDelay] in
            try? await Task.sleep(for: saveDelay)
            guard !Task.isCancelled else { return }
            _ = await save()
        }
    }

    private func saveNow() {
        pendingSave?.cancel()
        pendingSave = Task { _ = await save() }
    }

    /// Sends the draft, again if it changed while that was on its way, until the server has all of it.
    private func runSaves() async -> Bool {
        while hasUnsavedChanges {
            let sending = screens
            saveState = .saving
            do {
                try await api.saveTrmnlScreens(sending, for: device, siteID: siteID)
                saved = sending
            } catch {
                saveState = .failed
                saveRun = nil
                return false
            }
        }
        saveState = .saved
        saveRun = nil
        return true
    }

    // MARK: Previews

    private func schedulePreview() {
        pendingPreview?.cancel()
        pendingPreview = Task { [previewDelay] in
            try? await Task.sleep(for: previewDelay)
            guard !Task.isCancelled else { return }
            await loadSelectedPreview()
        }
    }

    private func previewSelectedScreen() {
        pendingPreview?.cancel()
        pendingPreview = Task { await loadSelectedPreview() }
    }

    private func loadSelectedPreview() async {
        guard screens.indices.contains(selectedIndex) else { return }
        let screen = screens[selectedIndex]
        let config = screen.componentConfig
        guard documents[config] == nil else { return }
        failed.remove(config)
        do {
            let document = try await api.fetchTrmnlPreview(siteID: siteID, screen: config)
            documents[config] = document
            shown[screen.id] = document
        } catch {
            guard !Task.isCancelled else { return }
            failed.insert(config)
        }
    }

    private static func numbered(_ screens: [TrmnlManagedScreen]) -> [TrmnlManagedScreen] {
        screens.enumerated().map { index, screen in
            var named = screen
            named.name = "Screen \(index + 1)"
            return named
        }
    }
}
