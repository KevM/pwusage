import SwiftUI

/// What Settings needs to open the Trmnl screen: where to read and save.
struct TrmnlSettingsAccess {
    let api: any MobileTrmnlAPI
}

/// Settings > Trmnl: edits the screens of the site's connected devices, one device at a time, with a
/// live preview of each. A site with no device gets the explainer and a way to add one.
struct TrmnlSettingsView: View {
    @Bindable var model: TrmnlSettingsModel
    @State private var editor: TrmnlScreensEditorModel?
    /// A device switch waiting on an answer about unsaved changes.
    @State private var pendingDeviceID: Int?
    @State private var isConfirmingLeave = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        content
            .navigationTitle(TrmnlPresentation.title)
            .inlineNavigationTitle()
            .navigationBarBackButtonHidden(hasUnsavedChanges)
            .toolbar { toolbarItems }
            .task { await model.load() }
            .task(id: model.selectedDeviceID) { await openEditor() }
            .onChange(of: scenePhase) { _, phase in
                // Back from trmnl.com, where a device may have just been added.
                if phase == .active { Task { await model.reloadDevices() } }
            }
            .confirmationDialog(
                TrmnlPresentation.discardTitle, isPresented: $isConfirmingLeave, titleVisibility: .visible
            ) {
                Button(TrmnlPresentation.discardTitle, role: .destructive) { dismiss() }
            }
            .confirmationDialog(
                TrmnlPresentation.discardTitle, isPresented: pendingSwitchBinding, titleVisibility: .visible
            ) {
                Button(TrmnlPresentation.discardTitle, role: .destructive) {
                    model.selectedDeviceID = pendingDeviceID
                    pendingDeviceID = nil
                }
            }
    }

    private var hasUnsavedChanges: Bool { editor?.hasUnsavedChanges == true }

    private var pendingSwitchBinding: Binding<Bool> {
        Binding(get: { pendingDeviceID != nil }, set: { if !$0 { pendingDeviceID = nil } })
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        switch model.devices {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed:
            List {
                Label(TrmnlPresentation.devicesFailure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Try Again") { Task { await model.load() } }
            }
        case .loaded(let devices) where devices.isEmpty:
            emptyState
        case .loaded(let devices):
            deviceEditor(devices)
        }
    }

    private var emptyState: some View {
        List {
            Section(TrmnlPresentation.previewHeader) {
                TrmnlPreviewContent(state: model.defaultPreview)
            }
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(TrmnlPresentation.emptyTitle).font(.headline)
                    Text(TrmnlPresentation.emptyMessage).font(.subheadline).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
            Section {
                Link(destination: TrmnlPresentation.addURL) {
                    Label(TrmnlPresentation.addTitle, systemImage: "plus.circle")
                }
                .accessibilityIdentifier("trmnl.add")
            }
        }
        .refreshable { await model.load() }
    }

    @ViewBuilder private func deviceEditor(_ devices: [TrmnlDevice]) -> some View {
        if let editor {
            switch editor.loadState {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed:
                List {
                    Label(TrmnlPresentation.screensLoadFailure, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Try Again") { Task { await editor.load() } }
                }
            case .ready:
                TrmnlScreensEditorView(editor: editor, devices: devices, onSelectDevice: requestSelect)
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder private var toolbarItems: some ToolbarContent {
        if hasUnsavedChanges {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { isConfirmingLeave = true }
            }
        }
        if let editor, editor.loadState == .ready {
            ToolbarItem(placement: .confirmationAction) {
                if editor.saveState == .saving {
                    ProgressView()
                } else {
                    Button(TrmnlPresentation.saveTitle) { Task { _ = await editor.save() } }
                        .disabled(!editor.hasUnsavedChanges)
                        .accessibilityIdentifier("trmnl.save")
                }
            }
        }
    }

    // MARK: Switching devices

    private func requestSelect(_ id: Int) {
        guard id != model.selectedDeviceID else { return }
        if hasUnsavedChanges { pendingDeviceID = id } else { model.selectedDeviceID = id }
    }

    private func openEditor() async {
        guard let device = model.selectedDevice else {
            editor = nil
            return
        }
        guard editor?.device.id != device.id else { return }
        let opened = model.makeEditor(for: device)
        editor = opened
        await opened.load()
    }
}

#if DEBUG
    private struct TrmnlPreviewAPI: MobileTrmnlAPI {
        let devices: [TrmnlDevice]

        func fetchTrmnlDevices(siteID _: String) async throws -> [TrmnlDevice] { devices }

        func fetchTrmnlPreview(siteID _: String, screen _: TrmnlComponentConfig?) async throws -> String {
            """
            <!doctype html><html><head><meta name="viewport" content="width=800">
            <style>body{margin:0;width:800px;height:480px;font:48px sans-serif;display:flex;
            align-items:center;justify-content:center}</style></head><body>Cedar House 4.2 kW</body></html>
            """
        }

        func fetchTrmnlScreens(uuid _: String) async throws -> [TrmnlManagedScreen] {
            [TrmnlManagedScreen(id: "screen-1", name: "Screen 1", componentConfig: .newScreen),
             TrmnlManagedScreen(id: "screen-2", name: "Screen 2", componentConfig: .newScreen)]
        }

        func saveTrmnlScreens(_: [TrmnlManagedScreen], for _: TrmnlDevice, siteID _: String) async throws {}
    }

    private func sampleDevice(id: Int, uuid: String) -> TrmnlDevice {
        TrmnlDevice(
            id: id, uuid: uuid, pluginSettingId: id + 6, connectedAt: .now,
            screen: TrmnlScreen(name: "Screen 1", index: 0, count: 2, componentConfig: .newScreen))
    }

    #Preview("Trmnl devices") {
        NavigationStack {
            TrmnlSettingsView(model: TrmnlSettingsModel(
                siteID: "preview-home",
                api: TrmnlPreviewAPI(devices: [
                    sampleDevice(id: 1, uuid: "abcdef12-0000"), sampleDevice(id: 2, uuid: "12345678-0000")
                ])))
        }
    }

    #Preview("Trmnl first time") {
        NavigationStack {
            TrmnlSettingsView(model: TrmnlSettingsModel(siteID: "preview-home", api: TrmnlPreviewAPI(devices: [])))
        }
    }
#endif
