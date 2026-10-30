import SwiftUI

/// The Home bar's title: the site name, or, once the Live card scrolls away, a
/// compact scoreboard of live stats in its place.
struct HomeLiveTitle: View {
    let siteName: String
    let scoreboard: DashboardPresentation.LiveScoreboard?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // The name stays; when the scoreboard arrives the name slides up to a small
        // top line and the stats rise in beneath it, like a title gaining a subtitle.
        VStack(spacing: 0) {
            Text(siteName)
                .font(scoreboard == nil ? .headline : .footnote.weight(.semibold))
                .foregroundStyle(scoreboard == nil ? .primary : .secondary)
                .lineLimit(1)
            if let scoreboard {
                ViewThatFits(in: .horizontal) {
                    // Nice-to-haves (grid, battery flow) go first, then home.
                    row(scoreboard, showsExtras: true, showsHome: true)
                    row(scoreboard, showsExtras: false, showsHome: true)
                    row(scoreboard, showsExtras: false, showsHome: false)
                    // Nothing fits: the name alone, never a row pushed past the bar.
                    EmptyView()
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                .id(scoreboard != nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(scoreboard?.accessibilityLabel(siteName: siteName) ?? siteName)
        .accessibilityAddTraits(.isHeader)
        .animation(.easeInOut(duration: 0.25), value: scoreboard == nil)
        // Two lines must fit the inline bar; larger sizes read through the large content viewer.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityShowsLargeContentViewer()
    }

    private func row(_ board: DashboardPresentation.LiveScoreboard, showsExtras: Bool, showsHome: Bool) -> some View {
        HStack(spacing: 12) {
            if let battery = board.battery {
                HStack(spacing: 3) {
                    glyph(battery.symbol, tint: .green)
                    value(battery.charge)
                    if showsExtras, let flow = battery.flow {
                        Text(flow)
                            .font(.system(.caption, design: .rounded, weight: .semibold))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize()
                            .contentTransition(reduceMotion ? .identity : .numericText())
                    }
                }
            }
            if showsHome { chip(board.home, tint: .blue) }
            chip(board.solar, tint: .orange)
            if showsExtras, let grid = board.grid { chip(grid, tint: .gray) }
        }
    }

    private func chip(_ stat: DashboardPresentation.ScoreboardStat, tint: Color) -> some View {
        HStack(spacing: 3) {
            // Solid glyphs read larger than the outlined battery, so they run a step smaller.
            glyph(stat.symbol, tint: tint)
                .imageScale(.small)
            value(stat.value)
        }
    }

    private func glyph(_ symbol: String, tint: Color) -> some View {
        Image(systemName: symbol)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(tint)
    }

    private func value(_ text: String) -> some View {
        Text(text)
            .font(.system(.subheadline, design: .rounded, weight: .semibold))
            .monospacedDigit()
            .lineLimit(1)
            .fixedSize()
            .contentTransition(reduceMotion ? .identity : .numericText())
    }
}

#if DEBUG
    private func previewScoreboard(solar: Double, home: Double, grid: Double, battery: Double,
                                   charge: Double?) -> DashboardPresentation.LiveScoreboard? {
        DashboardPresentation.liveScoreboard(
            flow: DashboardPresentation.powerFlow(
                solarPower: solar, loadPower: home, batteryPower: battery, gridPower: grid,
                sourceTime: .now, isUnavailable: false
            ),
            stateOfCharge: charge
        )
    }

    #Preview("Site name") {
        HomeLiveTitle(siteName: "Harrison", scoreboard: nil)
    }

    #Preview("Every chip") {
        HomeLiveTitle(siteName: "Harrison",
                      scoreboard: previewScoreboard(solar: 4000, home: 900, grid: -2000, battery: -1100, charge: 82))
    }

    #Preview("Narrow · essentials") {
        HomeLiveTitle(siteName: "Harrison",
                      scoreboard: previewScoreboard(solar: 4000, home: 900, grid: -2000, battery: -1100, charge: 82))
            .frame(width: 200)
    }

    #Preview("AX3") {
        HomeLiveTitle(siteName: "Harrison",
                      scoreboard: previewScoreboard(solar: 4000, home: 900, grid: -2000, battery: -1100, charge: 82))
            .frame(width: 240)
            .dynamicTypeSize(.accessibility3)
    }
#endif
