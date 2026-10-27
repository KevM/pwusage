#if DEBUG
    import SwiftUI
    import WidgetKit

    // Today's Metric is the configurable small widget. Today's Energy supports medium/large.
    // The layout board previews the actual shared content without the App Intents preview host.
    #Preview("All four small choices · Layout") {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                SmallMetricPreviewCard(metric: .home)
                SmallMetricPreviewCard(metric: .solar)
            }
            HStack(spacing: 12) {
                SmallMetricPreviewCard(metric: .grid)
                SmallMetricPreviewCard(metric: .battery)
            }
        }
        .padding(16)
        .background(Color(uiColor: .systemGroupedBackground))
    }

    #Preview("Small battery · Layout") {
        SmallMetricPreviewCard(metric: .battery)
    }

    private struct SmallMetricPreviewCard: View {
        let metric: TodayEnergyMetric

        var body: some View {
            TodayEnergyWidgetFamilyContent(snapshot: TodayEnergyPreviewFixtures.snapshot(),
                                           date: TodayEnergyPreviewFixtures.date, family: .systemSmall, metric: metric)
                .frame(width: 158, height: 158)
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    #Preview("Small · Home", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .home)
    }

    #Preview("Small · Solar", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .solar)
    }

    #Preview("Small · Grid", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .grid)
    }

    #Preview("Small · Battery", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .battery)
    }

    #Preview("Small · Stale grid", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date,
                               snapshot: TodayEnergyPreviewFixtures.snapshot(sourceAge: 2 * 3600), metric: .grid)
    }

    #Preview("Small · Unknown SOC", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date,
                               snapshot: TodayEnergyPreviewFixtures.snapshot(stateOfCharge: nil), metric: .battery)
    }

    #Preview("Small · No data", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: nil, metric: .solar)
    }
    #Preview("Small · Fresh to stale to next day", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .battery)
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date.addingTimeInterval(2 * 3600),
                               snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .battery)
        TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date.addingTimeInterval(24 * 3600),
                               snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .battery)
    }
#endif
