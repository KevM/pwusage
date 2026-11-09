import SwiftUI

extension TodayEnergyMetric {
    /// Data color for the metric: solar orange, Home blue, battery green, grid neutral.
    var tint: Color {
        switch self {
        case .home: .blue
        case .solar: .orange
        case .grid: .gray
        case .battery: .green
        }
    }
}

/// Full-bleed fill for the single-metric widget: the metric's color, deepened toward the bottom so
/// white text stays readable, with a soft glow from the top-leading corner.
struct TodayEnergyMetricFill: View {
    let metric: TodayEnergyMetric

    var body: some View {
        ZStack {
            LinearGradient(colors: [metric.tint.mix(with: .black, by: 0.08),
                                    metric.tint.mix(with: .black, by: 0.38)],
                           startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [.white.opacity(0.28), .clear],
                           center: .topLeading, startRadius: 0, endRadius: 150)
        }
    }
}
