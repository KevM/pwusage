import SwiftUI

/// What Settings needs to open the Trmnl screen: where to read from and where the web app lives.
struct TrmnlSettingsAccess {
    let api: any MobileTrmnlAPI
    let origin: URL
}

/// Settings > Trmnl: a preview of the site's screen and its connected devices.
struct TrmnlSettingsView: View {
    let origin: URL
    @Bindable var model: TrmnlSettingsModel
    @State private var screensDevice: TrmnlDevice?
    @Environment(\.scenePhase) private var scenePhase

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
        .task(id: model.selectedDeviceID) { await model.loadSelectedPreview() }
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
        if case .loaded(let devices) = model.devices, !devices.isEmpty {
            carousel(devices)
        } else {
            TrmnlPreviewContent(state: model.preview(for: nil))
        }
    }

    /// One page per device, each showing the screen that device is on. Swiping moves the highlight to
    /// the device's row below.
    private func carousel(_ devices: [TrmnlDevice]) -> some View {
        VStack(spacing: 8) {
            TabView(selection: $model.selectedDeviceID) {
                ForEach(devices) { device in
                    TrmnlPreviewContent(state: model.preview(for: device))
                        .tag(Optional(device.id))
                }
            }
            .tabViewStyle(.page(indexDisplayMode: devices.count > 1 ? .always : .never))
            .aspectRatio(TrmnlPreview.screenSize.width / TrmnlPreview.screenSize.height, contentMode: .fit)
            if let device = model.selectedDevice {
                Text(TrmnlPresentation.caption(for: device)).font(.footnote).foregroundStyle(.secondary)
            }
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
                ForEach(devices) { device in
                    deviceRow(device)
                        .listRowBackground(device.id == model.selectedDeviceID ? Color.emphasis.opacity(0.15) : nil)
                        .contentShape(Rectangle())
                        .onTapGesture { withAnimation { model.selectedDeviceID = device.id } }
                        .accessibilityAddTraits(device.id == model.selectedDeviceID ? .isSelected : [])
                }
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

        func fetchTrmnlPreview(siteID _: String, screen _: TrmnlComponentConfig?) async throws -> String {
            """
            <!doctype html><html><head><meta name="viewport" content="width=800">
            <style>body{margin:0;width:800px;height:480px;font:48px sans-serif;display:flex;
            align-items:center;justify-content:center}</style></head><body>Cedar House 4.2 kW</body></html>
            """
        }
    }

    private func sampleDevice(id: Int, uuid: String, screenIndex: Int, screenCount: Int) -> TrmnlDevice {
        TrmnlDevice(
            id: id, uuid: uuid, pluginSettingId: id + 6, connectedAt: .now,
            screen: TrmnlScreen(
                name: "Screen \(screenIndex + 1)", index: screenIndex, count: screenCount,
                componentConfig: TrmnlComponentConfig(
                    showLiveGrid: true, showLiveSolar: true, showLiveBattery: true, showEnergyChart: false,
                    showBatterySoc: false, showEstimatedBill: true, showLoadTiming: false, batterySocMode: "glyph")))
    }

    #Preview("Trmnl devices") {
        NavigationStack {
            TrmnlSettingsView(
                origin: URL(filePath: "/"),
                model: TrmnlSettingsModel(
                    siteID: "preview-home",
                    api: TrmnlPreviewAPI(devices: [
                        sampleDevice(id: 1, uuid: "abcdef12-0000", screenIndex: 1, screenCount: 3),
                        sampleDevice(id: 2, uuid: "12345678-0000", screenIndex: 0, screenCount: 1)
                    ])))
        }
    }

    #Preview("Trmnl first time") {
        NavigationStack {
            TrmnlSettingsView(
                origin: URL(filePath: "/"),
                model: TrmnlSettingsModel(siteID: "preview-home", api: TrmnlPreviewAPI(devices: [])))
        }
    }
#endif
