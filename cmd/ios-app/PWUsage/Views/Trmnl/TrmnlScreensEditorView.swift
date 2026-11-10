import SwiftUI

/// Edits the screens of one device: a carousel previewing each, and the controls for the selected one.
/// Wide viewports (landscape, iPad, Mac) put the preview beside the controls; narrow ones stack them.
struct TrmnlScreensEditorView: View {
    /// The width from which the preview and the controls sit side by side.
    static let wideBreakpoint: CGFloat = 700
    /// The controls column takes about a third of a wide viewport, within these bounds; the preview gets the rest.
    static let controlsWidthRange: ClosedRange<CGFloat> = 300 ... 420
    /// The space kept around the preview beside the controls.
    static let previewMargin: CGFloat = 12
    /// A pinned preview keeps to this width so it leaves room for the controls beneath it.
    static let pinnedPreviewMaxWidth: CGFloat = 340

    @Bindable var editor: TrmnlScreensEditorModel
    let devices: [TrmnlDevice]
    let onSelectDevice: (Int) -> Void
    @State private var isConfirmingDelete = false

    var body: some View {
        GeometryReader { proxy in
            if proxy.size.width >= Self.wideBreakpoint { wide } else { compact }
        }
        .confirmationDialog(
            TrmnlPresentation.deleteConfirmation(screenName: selectedName),
            isPresented: $isConfirmingDelete, titleVisibility: .visible
        ) {
            Button(TrmnlPresentation.deleteScreenTitle, role: .destructive) { editor.deleteSelectedScreen() }
        }
    }

    private var selectedName: String {
        editor.screens.indices.contains(editor.selectedIndex) ? editor.screens[editor.selectedIndex].name : ""
    }

    /// The preview stays pinned above the controls, so it is in view while a switch below it is changed.
    private var compact: some View {
        VStack(spacing: 0) {
            TrmnlScreenCarousel(editor: editor)
                .frame(maxWidth: Self.pinnedPreviewMaxWidth)
                .padding(.horizontal)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(Color(.systemGroupedBackground))
            List {
                deviceSection
                controlSections
                linksSection
            }
        }
    }

    /// The preview takes the largest 5 by 3 frame the space beside the controls allows, so it fills the
    /// height; where it sits in the rotation is shown above the controls instead of under it.
    private var wide: some View {
        GeometryReader { proxy in
            let controlsWidth = min(max(proxy.size.width * 0.36, Self.controlsWidthRange.lowerBound),
                                    Self.controlsWidthRange.upperBound)
            HStack(alignment: .top, spacing: 0) {
                GeometryReader { column in
                    let room = CGSize(
                        width: column.size.width - 2 * Self.previewMargin,
                        height: column.size.height - 2 * Self.previewMargin)
                    TrmnlScreenCarousel(editor: editor, showsPosition: false)
                        .frame(maxWidth: max(0, min(room.width, room.height * TrmnlPreview.aspectRatio)))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                List {
                    Section { TrmnlScreenPosition(editor: editor) }
                    deviceSection
                    controlSections
                    linksSection
                }
                .frame(width: controlsWidth)
            }
        }
    }

    // MARK: Device

    /// One row naming the device, a menu to switch when there are several.
    private var deviceSection: some View {
        Section {
            if devices.count > 1 {
                HStack {
                    Text("Device")
                    Spacer()
                    Menu {
                        ForEach(devices) { device in
                            Button(TrmnlPresentation.name(for: device)) { onSelectDevice(device.id) }
                        }
                    } label: {
                        Text(TrmnlPresentation.name(for: editor.device)).lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down").font(.footnote)
                    }
                }
            } else {
                LabeledContent("Device", value: TrmnlPresentation.name(for: editor.device))
            }
        }
    }

    private var linksSection: some View {
        Section {
            Link(TrmnlPresentation.openTitle, destination: TrmnlPresentation.openURL(for: editor.device))
            Link(TrmnlPresentation.addAnotherTitle, destination: TrmnlPresentation.addURL)
                .accessibilityIdentifier("trmnl.add")
        }
    }

    // MARK: Controls

    @ViewBuilder private var controlSections: some View {
        Section(TrmnlPresentation.liveStatsHeader) {
            Toggle("Grid", isOn: flag(\.showLiveGrid))
            Toggle("Solar", isOn: flag(\.showLiveSolar))
            Toggle("Battery", isOn: flag(\.showLiveBattery))
        }
        Section(TrmnlPresentation.chartsHeader) {
            Toggle("Energy usage chart", isOn: flag(\.showEnergyChart))
            Toggle("Battery level", isOn: flag(\.showBatterySoc))
            if selectedConfig?.showBatterySoc == true {
                Picker("Battery level display", selection: batteryMode) {
                    Text("Glyph").tag("glyph")
                    Text("Chart").tag("chart")
                }
                .pickerStyle(.segmented)
            }
            Toggle("Estimated monthly bill", isOn: flag(\.showEstimatedBill))
            Toggle("Smart Shift", isOn: flag(\.showLoadTiming))
        }
        Section(TrmnlPresentation.screenHeader) {
            Button(TrmnlPresentation.moveEarlierTitle, systemImage: "arrow.left") { editor.moveSelectedScreen(by: -1) }
                .disabled(!editor.canMoveSelectedScreen(by: -1))
            Button(TrmnlPresentation.moveLaterTitle, systemImage: "arrow.right") { editor.moveSelectedScreen(by: 1) }
                .disabled(!editor.canMoveSelectedScreen(by: 1))
            Button(TrmnlPresentation.addScreenTitle, systemImage: "plus") { editor.addScreen() }
                .disabled(!editor.canAddScreen)
            Button(TrmnlPresentation.deleteScreenTitle, systemImage: "trash", role: .destructive) {
                isConfirmingDelete = true
            }
            .disabled(!editor.canDeleteScreen)
        }
        if editor.saveState == .failed {
            Section {
                Label(TrmnlPresentation.saveFailure, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var selectedConfig: TrmnlComponentConfig? {
        guard editor.screens.indices.contains(editor.selectedIndex) else { return nil }
        return editor.screens[editor.selectedIndex].componentConfig
    }

    private func flag(_ keyPath: WritableKeyPath<TrmnlComponentConfig, Bool>) -> Binding<Bool> {
        Binding(
            get: { selectedConfig?[keyPath: keyPath] ?? false },
            set: { value in editor.update { $0[keyPath: keyPath] = value } })
    }

    private var batteryMode: Binding<String> {
        Binding(
            get: { selectedConfig?.batterySocMode ?? "chart" },
            set: { value in editor.update { $0.batterySocMode = value } })
    }
}
