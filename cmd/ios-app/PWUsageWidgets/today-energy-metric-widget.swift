import AppIntents
import SwiftUI
import WidgetKit

extension TodayEnergyMetric: AppEnum {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Energy Metric"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .home: "Home", .solar: "Solar", .grid: "Grid", .battery: "Battery"
    ]
}

struct TodayEnergyMetricConfiguration: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Today's Metric"
    static let description = IntentDescription("Choose Home, Solar, Grid, or Battery for your small widget.")

    @Parameter(title: "Metric", default: .home)
    var metric: TodayEnergyMetric

    static var parameterSummary: some ParameterSummary {
        Summary("Show \(\.$metric)")
    }

    init() {}
    init(metric: TodayEnergyMetric) { self.metric = metric }
}

struct TodayEnergyMetricEntry: TimelineEntry {
    let date: Date
    let snapshot: TodayEnergySnapshot?
    let metric: TodayEnergyMetric
}

struct TodayEnergyMetricProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TodayEnergyMetricEntry {
        let now = Date()
        return TodayEnergyMetricEntry(date: now, snapshot: .sample(at: now), metric: .home)
    }

    func snapshot(for configuration: TodayEnergyMetricConfiguration, in context: Context) async -> TodayEnergyMetricEntry {
        let now = Date()
        return TodayEnergyMetricEntry(date: now, snapshot: context.isPreview ? .sample(at: now) : TodayEnergySnapshotStore.shared()?.load(),
                                      metric: configuration.metric)
    }

    func timeline(for configuration: TodayEnergyMetricConfiguration, in context: Context) async -> Timeline<TodayEnergyMetricEntry> {
        let snapshot = await TodayEnergyWidgetRefresh.current()
        let now = Date()
        let entries = TodayEnergySnapshot.timelineDates(for: snapshot, at: now).map {
            TodayEnergyMetricEntry(date: $0, snapshot: snapshot, metric: configuration.metric)
        }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60)))
    }

    func recommendations() -> [AppIntentRecommendation<TodayEnergyMetricConfiguration>] {
        TodayEnergyMetric.allCases.map {
            AppIntentRecommendation(intent: TodayEnergyMetricConfiguration(metric: $0), description: $0.title)
        }
    }
}

struct TodayEnergyMetricWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: TodayEnergySnapshot.metricWidgetKind,
                               intent: TodayEnergyMetricConfiguration.self, provider: TodayEnergyMetricProvider()) { entry in
            TodayEnergyWidgetFamilyContent(snapshot: entry.snapshot, date: entry.date,
                                           family: .systemSmall, metric: entry.metric)
                .widgetURL(URL(string: "pwusage://dashboard"))
                .privacySensitive()
                .containerBackground(Color(uiColor: .secondarySystemGroupedBackground), for: .widget)
        }
        .configurationDisplayName("Today's Metric")
        .description("Choose Home, Solar, Grid, or Battery to see one of today's energy metrics.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}
