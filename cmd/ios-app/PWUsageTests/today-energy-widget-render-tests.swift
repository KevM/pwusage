import Foundation
@testable import PWUsage
import SwiftUI
import Testing
import WidgetKit

extension TodayEnergyWidgetTests {
    @MainActor
    @Test func renderActualWidgetContentForVisualInspection() throws {
        let fixtures: [(String, TodayEnergySnapshot?)] = [
            ("current", TodayEnergyPreviewFixtures.snapshot()),
            ("stale", TodayEnergyPreviewFixtures.snapshot(sourceAge: 2 * 3600)),
            ("unknown-charge", TodayEnergyPreviewFixtures.snapshot(stateOfCharge: nil)),
            ("partial", TodayEnergyPreviewFixtures.snapshot(complete: false)),
            ("long-name", TodayEnergyPreviewFixtures.snapshot(homeKwh: 1234.5, solarKwh: 456.7, gridNetKwh: 987.6,
                                                              batteryNetKwh: -209.8,
                                                              siteName: "Our family's home with a long site name")),
            ("no-cost", TodayEnergyPreviewFixtures.snapshot(todayCost: nil)),
            ("net-credit", TodayEnergyPreviewFixtures.snapshot(
                todayCost: TodayEnergyCost(netCost: -2.5, importCharges: 0,
                                           exportCredits: 2.5, currency: "EUR"))),
            ("missing", nil)
        ]
        let smallView = TodayEnergyWidgetContent(snapshot: TodayEnergyPreviewFixtures.snapshot(),
                                                 date: TodayEnergyPreviewFixtures.date, compact: true)
            .padding(TodayEnergyWidgetLayout.mediumInsets).frame(width: 292, height: 141)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .environment(\.colorScheme, .light)
        try render(smallView, name: "today-widget-small-medium.png")
        let largerTextView = TodayEnergyWidgetContent(snapshot: TodayEnergyPreviewFixtures.snapshot(),
                                                      date: TodayEnergyPreviewFixtures.date, compact: true)
            .padding(TodayEnergyWidgetLayout.mediumInsets).frame(width: 338, height: 158)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .environment(\.colorScheme, .light).environment(\.dynamicTypeSize, .xxxLarge)
        try render(largerTextView, name: "today-widget-medium-larger-text.png")
        for compact in [true, false] {
            for dark in [false, true] {
                for (name, snapshot) in fixtures {
                    let view = TodayEnergyWidgetContent(snapshot: snapshot,
                                                        date: TodayEnergyPreviewFixtures.date,
                                                        compact: compact)
                        .padding(compact ? TodayEnergyWidgetLayout.mediumInsets : TodayEnergyWidgetLayout.largeInsets)
                        .frame(width: 338, height: compact ? 158 : 354)
                        .background(Color(uiColor: .secondarySystemGroupedBackground))
                        .environment(\.colorScheme, dark ? .dark : .light)
                    let suffix = "\(compact ? "medium" : "large")-\(dark ? "dark" : "light")-\(name)"
                    try render(view, name: "today-widget-\(suffix).png")
                }
            }
        }
    }

    struct WidgetSelection {
        let name: String
        let metric: TodayEnergyMetric
        let snapshot: TodayEnergySnapshot?
    }

    @MainActor
    @Test func renderSmallWidgetSelections() throws {
        let extras: [WidgetSelection] = [
            WidgetSelection(name: "stale-grid", metric: .grid,
                            snapshot: TodayEnergyPreviewFixtures.snapshot(sourceAge: 2 * 3600)),
            WidgetSelection(name: "full-soc", metric: .battery,
                            snapshot: TodayEnergyPreviewFixtures.snapshot(stateOfCharge: 100)),
            WidgetSelection(name: "unknown-soc", metric: .battery,
                            snapshot: TodayEnergyPreviewFixtures.snapshot(stateOfCharge: nil)),
            WidgetSelection(name: "large-number", metric: .grid,
                            snapshot: TodayEnergyPreviewFixtures.snapshot(gridNetKwh: 1234.5)),
            WidgetSelection(name: "missing", metric: .solar, snapshot: nil)
        ]
        let cases = TodayEnergyMetric.allCases.map {
            WidgetSelection(name: $0.rawValue, metric: $0, snapshot: TodayEnergyPreviewFixtures.snapshot())
        } + extras
        for selection in cases {
            for dark in [false, true] {
                let view = TodayEnergySingleMetricContent(snapshot: selection.snapshot,
                                                          date: TodayEnergyPreviewFixtures.date,
                                                          metric: selection.metric)
                    .padding(10).frame(width: 141, height: 141)
                    .background(Color(uiColor: .secondarySystemGroupedBackground))
                    .environment(\.colorScheme, dark ? .dark : .light)
                    .environment(\.dynamicTypeSize, .xxxLarge)
                try render(view, name: "today-widget-small-\(selection.name)-\(dark ? "dark" : "light").png")
            }
        }
    }

    @MainActor
    @Test func renderActualFamilyRoutingForCanvasOverride() throws {
        for metric in [TodayEnergyMetric.home, .battery] {
            let view = TodayEnergyWidgetFamilyContent(snapshot: TodayEnergyPreviewFixtures.snapshot(),
                                                      date: TodayEnergyPreviewFixtures.date,
                                                      family: .systemSmall, metric: metric)
                .frame(width: 141, height: 141)
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .environment(\.colorScheme, .light)
            try render(view, name: "today-widget-canvas-small-\(metric.rawValue).png")
        }
    }

    @MainActor
    private func render(_ view: some View, name: String) throws {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let png = try #require(renderer.uiImage?.pngData())
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
        try png.write(to: output)
        print("Today widget render: \(output.path)")
    }
}
