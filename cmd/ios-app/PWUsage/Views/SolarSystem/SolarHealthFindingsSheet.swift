import SwiftUI

/// Context needed to render and scrub the house model when inspecting a health finding.
struct SolarHouseInspectionContext: Equatable, Sendable {
    var layout: SolarLayout?
    var manualLayout: ManualSolarLayout?
    var result: SolarHealthResult?
    var latitude = 40.0
    var longitude = 0.0
}

/// Short display category for a `SolarHealthFindingKind`, used in summary chips and the Findings sheet.
enum SolarHealthFindingCategory: Hashable, Sendable {
    case shading
    case soiling
    case aging
    case output

    init(kind: SolarHealthFindingKind) {
        switch kind {
        case .shading, .shadingGrowth: self = .shading
        case .soiling: self = .soiling
        case .aging: self = .aging
        case .stepFault, .lowOutput: self = .output
        }
    }

    var label: String {
        switch self {
        case .shading: "Shading"
        case .soiling: "Soiling"
        case .aging: "Aging"
        case .output: "Output"
        }
    }

    var systemImage: String {
        switch self {
        case .shading: "cloud.sun"
        case .soiling: "aqi.medium"
        case .aging: "clock.arrow.circlepath"
        case .output: "bolt.trianglebadge.exclamationmark"
        }
    }

    static func unique(in findings: [SolarHealthFinding]) -> [Self] {
        var seen: Set<Self> = []
        var ordered: [Self] = []
        for finding in findings {
            let category = Self(kind: finding.kind)
            if seen.insert(category).inserted {
                ordered.append(category)
            }
        }
        return ordered
    }
}

/// Sheet listing all visible panel-health findings, each opening a house inspection view.
struct SolarHealthFindingsSheet: View {
    let report: SolarHealthReport
    let context: SolarHouseInspectionContext
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if report.visibleFindings.isEmpty {
                        Label("No issues found", systemImage: "checkmark.circle")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(report.visibleFindings) { finding in
                            findingRow(finding)
                        }
                    }
                }
            }
            .navigationTitle("Findings")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func findingRow(_ finding: SolarHealthFinding) -> some View {
        if context.layout != nil {
            NavigationLink {
                SolarHealthFindingInspectionView(
                    finding: finding,
                    report: report,
                    context: context)
            } label: {
                SolarHealthFindingRowContent(finding: finding)
            }
        } else {
            SolarHealthFindingRowContent(finding: finding)
        }
    }
}

private struct SolarHealthFindingRowContent: View {
    let finding: SolarHealthFinding

    private var category: SolarHealthFindingCategory {
        SolarHealthFindingCategory(kind: finding.kind)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Label(category.label, systemImage: category.systemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.emphasis)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.emphasis.opacity(0.14), in: Capsule())
                Spacer()
                Text("\(finding.confidence.label) · \(finding.clearDays) clear days")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(finding.title)
                .font(.subheadline.weight(.semibold))
            Text(finding.detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// Interactive house inspection view pre-set to the state of a specific finding.
struct SolarHealthFindingInspectionView: View {
    let finding: SolarHealthFinding
    let report: SolarHealthReport
    let context: SolarHouseInspectionContext

    @State private var healthState: SolarHouseHealthState

    init(
        finding: SolarHealthFinding,
        report: SolarHealthReport,
        context: SolarHouseInspectionContext
    ) {
        self.finding = finding
        self.report = report
        self.context = context
        _healthState = State(initialValue: SolarHouseHealthOverlay.initialState(
            for: finding,
            in: context.result,
            latitude: context.latitude,
            longitude: context.longitude))
    }

    private var category: SolarHealthFindingCategory {
        SolarHealthFindingCategory(kind: finding.kind)
    }

    private var overlay: SolarHouseHealthOverlay {
        SolarHouseHealthOverlay(
            report: report,
            result: context.result,
            state: healthState,
            latitude: context.latitude,
            longitude: context.longitude)
    }

    private var shadedMoment: (season: SolarSeason, hourOfDay: Double)? {
        SolarHouseHealthOverlay.firstShadedMoment(
            in: context.result,
            latitude: context.latitude,
            longitude: context.longitude)
    }

    var body: some View {
        let currentOverlay = overlay
        let sceneDate = healthState.selectedYear.map(SolarHouseHealthOverlay.endOfYearDate) ?? .now
        List {
            Section {
                SolarSystemVisual(
                    input: SolarSystemSceneInput(
                        status: nil,
                        layout: context.layout,
                        isWaiting: false,
                        manualLayout: context.manualLayout,
                        healthOverlay: currentOverlay,
                        now: sceneDate),
                    summary: finding.title)
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 12, trailing: 0))
                SolarSystemHealthControls(
                    state: $healthState,
                    report: report,
                    overlay: currentOverlay,
                    shadedMoment: shadedMoment)
            } header: {
                Text(category.label)
            }
            Section("Details") {
                VStack(alignment: .leading, spacing: 6) {
                    Text(finding.title)
                        .font(.subheadline.weight(.semibold))
                    Text(finding.detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("\(finding.confidence.label) · \(finding.clearDays) clear days")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
                if !report.changeOverTime.months.isEmpty || !report.dailyRatios.isEmpty {
                    NavigationLink("Capacity & Ratio Trend") {
                        SolarHealthTrendView(report: report)
                    }
                }
            }
        }
        .navigationTitle(category.label)
        .inlineNavigationTitle()
    }
}
