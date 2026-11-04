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
    static let singleMetricInsets = EdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10)
    static let mediumInsets = EdgeInsets(top: 13, leading: 16, bottom: 12, trailing: 16)
    static let largeInsets = EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)
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
            TodayEnergySingleMetricContent(snapshot: snapshot, date: date, metric: selection)
                .padding(TodayEnergyWidgetLayout.singleMetricInsets)
        case .medium:
            TodayEnergyWidgetContent(snapshot: snapshot, date: date, compact: true)
                .padding(TodayEnergyWidgetLayout.mediumInsets)
        case .large:
            TodayEnergyWidgetContent(snapshot: snapshot, date: date, compact: false)
                .padding(TodayEnergyWidgetLayout.largeInsets)
        }
    }
}
