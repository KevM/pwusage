import SwiftUI
import WidgetKit

enum TodayEnergyWidgetLayout: Equatable {
    case singleMetric(TodayEnergyMetric)
    case medium
    case large

    init(family: WidgetFamily, metric: TodayEnergyMetric = .home) {
        switch family {
        case .systemSmall: self = .singleMetric(metric)
        case .systemMedium: self = .medium
        default: self = .large
        }
    }
}

/// Routes actual WidgetKit families, including Xcode Canvas overrides of unsupported gallery sizes.
struct TodayEnergyWidgetFamilyContent: View {
    let snapshot: TodayEnergySnapshot?
    let date: Date
    let family: WidgetFamily
    var metric: TodayEnergyMetric = .home

    @ViewBuilder
    var body: some View {
        switch TodayEnergyWidgetLayout(family: family, metric: metric) {
        case .singleMetric(let selection):
            TodayEnergySingleMetricContent(snapshot: snapshot, date: date, metric: selection).padding(10)
        case .medium:
            TodayEnergyWidgetContent(snapshot: snapshot, date: date, compact: true).padding(10)
        case .large:
            TodayEnergyWidgetContent(snapshot: snapshot, date: date, compact: false).padding(16)
        }
    }
}
