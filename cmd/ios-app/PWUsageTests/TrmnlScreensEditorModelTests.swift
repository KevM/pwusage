import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Trmnl screens editor model")
struct TrmnlScreensEditorModelTests {
    private let device = TrmnlDevice.fixture(id: 1, uuid: "abc-123", screenIndex: 1, screenCount: 2)

    private func screen(_ id: String, bill: Bool = false) -> TrmnlManagedScreen {
        TrmnlManagedScreen(id: id, name: "x", componentConfig: .fixture(showEstimatedBill: bill))
    }

    private func make(
        screens: [TrmnlManagedScreen]? = nil, delay: Duration = .milliseconds(40),
        saveDelay: Duration = .milliseconds(60)
    ) -> (TrmnlScreensEditorModel, FakeScreensAPI) {
        let api = FakeScreensAPI(screens: screens ?? [screen("a"), screen("b", bill: true)])
        var nextID = 0
        let model = TrmnlScreensEditorModel(
            device: device, siteID: "site-1", api: api, previewDelay: delay, saveDelay: saveDelay,
            makeScreenID: { nextID += 1
                return "new-\(nextID)" })
        return (model, api)
    }

    @Test("Loading opens on the screen the device is showing and previews it")
    func loadsAtCurrentScreen() async throws {
        let (model, api) = make()
        #expect(model.loadState == .loading)
        await model.load()
        #expect(model.loadState == .ready)
        #expect(model.screens.map(\.name) == ["Screen 1", "Screen 2"])
        #expect(model.selectedIndex == 1)
        try await eventually { model.preview(forScreenAt: 1) == .ready(document: "<doc/>") }
        #expect(api.previewRequests == [.fixture(showEstimatedBill: true)])
        #expect(model.hasUnsavedChanges == false)
    }

    @Test("A screens list that cannot load says so")
    func loadFailure() async {
        let (model, api) = make()
        api.screensFailure = URLError(.notConnectedToInternet)
        await model.load()
        #expect(model.loadState == .failed)
    }

    @Test("A burst of edits waits for quiet, then previews only the final state once")
    func debouncedEdits() async throws {
        let (model, api) = make(delay: .milliseconds(80))
        await model.load()
        try await eventually { api.previewRequests.count == 1 }
        model.update { $0.showEnergyChart = true }
        model.update { $0.showLoadTiming = true }
        model.update { $0.showLiveGrid = false }
        try await staysTrue(for: .milliseconds(30)) { api.previewRequests.count == 1 }
        try await eventually { api.previewRequests.count == 2 }
        try await staysTrue(for: .milliseconds(200)) { api.previewRequests.count == 2 }
        let final = try #require(api.previewRequests.last)
        #expect(final.showEnergyChart && final.showLoadTiming && !final.showLiveGrid)
    }

    @Test("Each further edit pushes the preview out again")
    func editsExtendTheWait() async throws {
        let (model, api) = make(delay: .milliseconds(120))
        await model.load()
        try await eventually { api.previewRequests.count == 1 }
        model.update { $0.showLoadTiming = true }
        try await Task.sleep(for: .milliseconds(70))
        model.update { $0.showEnergyChart = true }
        try await Task.sleep(for: .milliseconds(70))
        #expect(api.previewRequests.count == 1)
        try await eventually { api.previewRequests.count == 2 }
    }

    @Test("Going back to a state already previewed reuses it without a request")
    func cachedPreview() async throws {
        let (model, api) = make()
        await model.load()
        try await eventually { api.previewRequests.count == 1 }
        model.update { $0.showLoadTiming = true }
        try await eventually { api.previewRequests.count == 2 }
        model.update { $0.showLoadTiming = false }
        #expect(model.preview(forScreenAt: 1) == .ready(document: "<doc/>"))
        try await staysTrue(for: .milliseconds(150)) { api.previewRequests.count == 2 }
    }

    @Test("A failed preview marks only that state unavailable")
    func previewFailure() async throws {
        let (model, api) = make()
        api.previewFailures = [.fixture(showEstimatedBill: true)]
        await model.load()
        try await eventually { model.preview(forScreenAt: 1) == .unavailable }
        model.select(0)
        try await eventually { model.preview(forScreenAt: 0) == .ready(document: "<doc/>") }
    }

    @Test("Swiping to a screen previews it at once")
    func selectingPreviewsImmediately() async throws {
        let (model, api) = make(delay: .seconds(5))
        await model.load()
        model.select(0)
        #expect(model.selectedIndex == 0)
        try await eventually { api.previewRequests.contains(.fixture()) }
    }

    @Test("Edits mark the draft unsaved, and undoing them clears it")
    func unsavedChanges() async {
        let (model, _) = make()
        await model.load()
        #expect(!model.hasUnsavedChanges)
        model.update { $0.showEnergyChart = true }
        #expect(model.hasUnsavedChanges)
        model.update { $0.showEnergyChart = false }
        #expect(!model.hasUnsavedChanges)
    }

    @Test("Screens are added up to three, deleted down to one, and renamed by position")
    func addAndDelete() async {
        let (model, _) = make()
        await model.load()
        #expect(model.canAddScreen)
        model.addScreen()
        #expect(model.screens.map(\.name) == ["Screen 1", "Screen 2", "Screen 3"])
        #expect(model.screens.last?.componentConfig == .newScreen)
        #expect(model.selectedIndex == 2)
        #expect(!model.canAddScreen)
        model.addScreen()
        #expect(model.screens.count == 3)

        model.deleteSelectedScreen()
        #expect(model.screens.map(\.name) == ["Screen 1", "Screen 2"])
        #expect(model.selectedIndex == 1)
        model.select(0)
        model.deleteSelectedScreen()
        #expect(model.screens.count == 1)
        #expect(!model.canDeleteScreen)
        model.deleteSelectedScreen()
        #expect(model.screens.count == 1)
        #expect(model.hasUnsavedChanges)
    }

    @Test("A screen moves left and right and stays selected")
    func moving() async {
        let (model, _) = make()
        await model.load()
        model.select(1)
        #expect(model.canMoveSelectedScreen(by: -1))
        #expect(!model.canMoveSelectedScreen(by: 1))
        model.moveSelectedScreen(by: -1)
        #expect(model.screens.map(\.id) == ["b", "a"])
        #expect(model.screens.map(\.name) == ["Screen 1", "Screen 2"])
        #expect(model.selectedIndex == 0)
        #expect(model.hasUnsavedChanges)
        model.moveSelectedScreen(by: -1)
        #expect(model.selectedIndex == 0)
    }

    @Test("An edit saves after things go quiet, once, with everything changed in the meantime")
    func autosavesAfterQuiet() async throws {
        let (model, api) = make(saveDelay: .milliseconds(80))
        await model.load()
        model.update { $0.showEnergyChart = true }
        model.update { $0.showLoadTiming = true }
        #expect(model.saveState == .idle)
        try await staysTrue(for: .milliseconds(30)) { api.saves.isEmpty }
        try await eventually { api.saves.count == 1 }
        try await eventually { model.saveState == .saved }
        let saved = try #require(api.saves.first)
        #expect(saved.screens.map(\.name) == ["Screen 1", "Screen 2"])
        #expect(saved.screens[1].componentConfig.showEnergyChart)
        #expect(saved.screens[1].componentConfig.showLoadTiming)
        #expect(saved.device == device)
        #expect(saved.siteID == "site-1")
        #expect(!model.hasUnsavedChanges)
        try await staysTrue(for: .milliseconds(150)) { api.saves.count == 1 }
    }

    @Test("Each further edit pushes the save out again")
    func editsExtendTheSaveWait() async throws {
        let (model, api) = make(saveDelay: .milliseconds(150))
        await model.load()
        model.update { $0.showEnergyChart = true }
        try await Task.sleep(for: .milliseconds(90))
        model.update { $0.showLoadTiming = true }
        try await Task.sleep(for: .milliseconds(90))
        #expect(api.saves.isEmpty)
        try await eventually { api.saves.count == 1 }
    }

    @Test("Adding, deleting and moving a screen save at once")
    func structuralChangesSaveAtOnce() async throws {
        let (model, api) = make(saveDelay: .seconds(30))
        await model.load()
        model.addScreen()
        try await eventually { api.saves.count == 1 }
        #expect(api.saves[0].screens.count == 3)
        model.moveSelectedScreen(by: -1)
        try await eventually { api.saves.count == 2 }
        model.deleteSelectedScreen()
        try await eventually { api.saves.count == 3 }
        #expect(api.saves[2].screens.count == 2)
    }

    @Test("Leaving saves what is waiting without the quiet period")
    func flush() async throws {
        let (model, api) = make(saveDelay: .seconds(30))
        await model.load()
        model.update { $0.showEnergyChart = true }
        #expect(await model.flush())
        #expect(api.saves.count == 1)
        #expect(!model.hasUnsavedChanges)
        #expect(await model.flush())
        #expect(api.saves.count == 1)
    }

    @Test("An edit made while a save is on its way is saved next, and nothing is lost")
    func editDuringSave() async throws {
        let (model, api) = make(saveDelay: .milliseconds(20))
        api.saveLatency = .milliseconds(150)
        await model.load()
        model.update { $0.showEnergyChart = true }
        try await eventually { api.saveStarts == 1 }
        model.update { $0.showLoadTiming = true }
        try await eventually { api.saves.count == 2 }
        try await eventually { model.saveState == .saved }
        #expect(api.saves[1].screens[1].componentConfig.showLoadTiming)
        #expect(!model.hasUnsavedChanges)
    }

    @Test("A failed save keeps the edits, says so, and is retried by the next edit or a retry")
    func saveFailure() async throws {
        let (model, api) = make()
        await model.load()
        api.saveFailure = URLError(.timedOut)
        model.update { $0.showEnergyChart = true }
        try await eventually { model.saveState == .failed }
        #expect(model.hasUnsavedChanges)
        api.saveFailure = nil
        #expect(await model.save())
        #expect(model.saveState == .saved)
        #expect(!model.hasUnsavedChanges)
    }

    @Test("A draft with nothing changed saves nothing")
    func cleanDraft() async {
        let (model, api) = make()
        await model.load()
        #expect(await model.save())
        #expect(await model.flush())
        #expect(api.saves.isEmpty)
        #expect(model.saveState == .idle)
    }
}

private final class FakeScreensAPI: MobileTrmnlAPI, @unchecked Sendable {
    struct Saved {
        let screens: [TrmnlManagedScreen]
        let device: TrmnlDevice
        let siteID: String
    }

    var screens: [TrmnlManagedScreen]
    var screensFailure: (any Error)?
    var saveFailure: (any Error)?
    var previewFailures: [TrmnlComponentConfig] = []
    private(set) var previewRequests: [TrmnlComponentConfig] = []
    var saveLatency: Duration = .zero
    private(set) var saves: [Saved] = []
    private(set) var saveStarts = 0

    init(screens: [TrmnlManagedScreen]) { self.screens = screens }

    func fetchTrmnlDevices(siteID _: String) async throws -> [TrmnlDevice] { [] }

    func fetchTrmnlPreview(siteID _: String, screen: TrmnlComponentConfig?) async throws -> String {
        if let screen {
            previewRequests.append(screen)
            if previewFailures.contains(screen) { throw URLError(.timedOut) }
        }
        return "<doc/>"
    }

    func fetchTrmnlScreens(uuid _: String) async throws -> [TrmnlManagedScreen] {
        if let screensFailure { throw screensFailure }
        return screens
    }

    func saveTrmnlScreens(_ screens: [TrmnlManagedScreen], for device: TrmnlDevice, siteID: String) async throws {
        saveStarts += 1
        if saveLatency > .zero { try await Task.sleep(for: saveLatency) }
        if let saveFailure { throw saveFailure }
        saves.append(Saved(screens: screens, device: device, siteID: siteID))
    }
}
