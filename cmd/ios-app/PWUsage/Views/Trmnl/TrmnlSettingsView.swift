import SwiftUI

/// What Settings needs to open the Trmnl screen: where to read from and where the web app lives.
struct TrmnlSettingsAccess {
    let api: any MobileTrmnlAPI
    let origin: URL
}

/// Settings > Trmnl: a preview of the site's screen and its connected devices.
struct TrmnlSettingsView: View {
    let origin: URL
    @State private var model: TrmnlSettingsModel
    @State private var screensDevice: TrmnlDevice?
    @Environment(\.scenePhase) private var scenePhase

    init(siteID: String, access: TrmnlSettingsAccess) {
        origin = access.origin
        _model = State(initialValue: TrmnlSettingsModel(siteID: siteID, api: access.api))
    }

    var body: some View {
        List {
            Section(TrmnlPresentation.previewHeader) { previewRow }
            devicesSections
            Section {
                Link(destination: TrmnlPresentation.addURL) {
                    Label(TrmnlPresentation.addButtonTitle(deviceCount: deviceCount), systemImage: "plus.circle")
                }
                .accessibilityIdentifier("trmnl.add")
            }
        }
        .navigationTitle(TrmnlPresentation.title)
        .inlineNavigationTitle()
        .task { await model.load() }
        .refreshable { await model.load() }
        .onChange(of: scenePhase) { _, phase in
            // Back from trmnl.com, where a device may have just been added.
            if phase == .active { Task { await model.reloadDevices() } }
        }
        .sheet(item: $screensDevice) {
            TrmnlScreensSheet(url: TrmnlPresentation.screensURL(origin: origin, device: $0))
        }
    }

    private var deviceCount: Int {
        if case .loaded(let devices) = model.devices { devices.count } else { 0 }
    }

    @ViewBuilder private var previewRow: some View {
        switch model.preview {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity)
                .aspectRatio(TrmnlPreview.screenSize.width / TrmnlPreview.screenSize.height, contentMode: .fit)
        case .ready(let document):
            TrmnlPreview(document: document)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator))
                .accessibilityLabel("Preview of your Trmnl screen")
        case .unavailable:
            Text(TrmnlPresentation.previewUnavailable).font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var devicesSections: some View {
        switch model.devices {
        case .loading:
            EmptyView()
        case .failed:
            Section(TrmnlPresentation.devicesHeader) {
                Label(TrmnlPresentation.devicesFailure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Try Again") { Task { await model.reloadDevices() } }
            }
        case .loaded(let devices) where devices.isEmpty:
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(TrmnlPresentation.emptyTitle).font(.headline)
                    Text(TrmnlPresentation.emptyMessage).font(.subheadline).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        case .loaded(let devices):
            Section(TrmnlPresentation.devicesHeader) {
                ForEach(devices) { deviceRow($0) }
            }
        }
    }

    private func deviceRow(_ device: TrmnlDevice) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(TrmnlPresentation.name(for: device)).font(.body.weight(.semibold))
                if let connected = TrmnlPresentation.connectedLabel(for: device) {
                    Text(connected).font(.footnote).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 10) {
                Button(TrmnlPresentation.screensTitle) { screensDevice = device }
                    .emphasisProminentButton()
                Link(TrmnlPresentation.openTitle, destination: TrmnlPresentation.openURL(for: device))
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }
}

#if DEBUG
    private struct TrmnlPreviewAPI: MobileTrmnlAPI {
        let devices: [TrmnlDevice]

        func fetchTrmnlDevices(siteID _: String) async throws -> [TrmnlDevice] { devices }

        func fetchTrmnlPreview(siteID _: String) async throws -> String {
            """
            <!doctype html><html><head><meta name="viewport" content="width=800">
            <style>body{margin:0;width:800px;height:480px;font:48px sans-serif;display:flex;
            align-items:center;justify-content:center}</style></head><body>Cedar House 4.2 kW</body></html>
            """
        }
    }

    #Preview("Trmnl devices") {
        NavigationStack {
            TrmnlSettingsView(
                siteID: "preview-home",
                access: TrmnlSettingsAccess(
                    api: TrmnlPreviewAPI(devices: [
                        TrmnlDevice(id: 1, uuid: "abcdef12-0000", pluginSettingId: 7, connectedAt: .now),
                        TrmnlDevice(id: 2, uuid: "12345678-0000", pluginSettingId: 8, connectedAt: nil)
                    ]),
                    origin: URL(filePath: "/")))
        }
    }

    #Preview("Trmnl first time") {
        NavigationStack {
            TrmnlSettingsView(
                siteID: "preview-home",
                access: TrmnlSettingsAccess(api: TrmnlPreviewAPI(devices: []), origin: URL(filePath: "/")))
        }
    }
#endif
