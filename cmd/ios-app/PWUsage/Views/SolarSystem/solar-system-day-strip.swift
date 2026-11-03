import SwiftUI

/// The calendar strip: a cell per stored day in its type's color. Tapping a day shows its date and
/// type; VoiceOver steps through the weeks.
struct SolarSystemDayStrip: View {
    let layout: SolarSystemStripLayout
    let days: [SiteHistoryStatus.Day]
    let clocks: SolarSystemSceneClocks
    let now: Date

    @State private var selected: String?
    @State private var week = Int.max

    private var types: [String: SolarDayType?] {
        Dictionary(days.map { ($0.day, $0.type) }, uniquingKeysWith: { $1 })
    }

    var body: some View {
        let types = types
        Canvas { context, _ in
            for label in layout.labels {
                let text = Text(label.text)
                    .font(.system(size: 11))
                    .foregroundStyle(label.kind == .year ? .tertiary : .secondary)
                context.draw(text, at: layout.labelOrigin(label), anchor: label.trailing ? .trailing : .leading)
            }
            for cell in layout.cells {
                let type = types[cell.day] ?? nil
                let growth = clocks.growth(cell.day, at: now)
                guard growth > 0 else { continue }
                let frame = layout.frame(cell)
                // A new day grows from a speck (1.2 of 3.6) to its full dot.
                let radius = frame.width / 2 * (1.2 + 2.4 * growth) / 3.6
                let dot = Path(ellipseIn: CGRect(
                    x: frame.midX - radius, y: frame.midY - radius, width: 2 * radius, height: 2 * radius))
                if type == .noProduction {
                    context.stroke(dot, with: .color(SolarSystemColors.noProduction),
                                   style: StrokeStyle(lineWidth: 1, dash: [1.5, 1.5]))
                } else {
                    context.fill(dot, with: .color(SolarSystemColors.color(type)))
                }
                if cell.day == selected {
                    context.stroke(Path(ellipseIn: frame.insetBy(dx: -2, dy: -2)), with: .color(.primary),
                                   lineWidth: 1.5)
                }
            }
        }
        .frame(height: layout.height)
        .contentShape(Rectangle())
        .onTapGesture(coordinateSpace: .local) { point in
            let day = layout.cell(at: point)?.day
            selected = day == selected ? nil : day
        }
        .overlay(alignment: .topLeading) { callout(types) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Downloaded days")
        .accessibilityValue(weekSummary(types))
        .accessibilityAdjustableAction { direction in
            let count = weekStarts.count
            guard count > 0 else { return }
            let current = min(week, count - 1)
            switch direction {
            case .increment: week = min(current + 1, count - 1)
            case .decrement: week = max(current - 1, 0)
            @unknown default: break
            }
        }
    }

    @ViewBuilder private func callout(_ types: [String: SolarDayType?]) -> some View {
        if let selected, let cell = layout.cells.first(where: { $0.day == selected }) {
            let frame = layout.frame(cell)
            let type = types[selected] ?? nil
            HStack(spacing: 4) {
                Circle().fill(SolarSystemColors.color(type)).frame(width: 7, height: 7)
                Text("\(Self.shortDate(selected)) · \(SolarSystemColors.name(type))")
            }
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.regularMaterial, in: Capsule())
            .fixedSize()
            .position(x: min(max(frame.midX, 60), layout.width - 60), y: max(frame.minY - 14, 8))
            .transition(.opacity)
        }
    }

    // MARK: - VoiceOver

    /// The first stored day of each week, oldest first.
    private var weekStarts: [String] {
        var seen = Set<Int>()
        return layout.cells.compactMap { cell in
            let key = cell.band * 1000 + cell.column
            return seen.insert(key).inserted ? cell.day : nil
        }
    }

    private func weekSummary(_ types: [String: SolarDayType?]) -> String {
        let starts = weekStarts
        guard !starts.isEmpty else { return "None yet" }
        let index = min(week, starts.count - 1)
        guard let first = layout.cells.first(where: { $0.day == starts[index] }) else { return "" }
        let inWeek = layout.cells.filter { $0.band == first.band && $0.column == first.column }
        let counts = Dictionary(grouping: inWeek) { types[$0.day] ?? nil }.mapValues(\.count)
        let parts = [SolarDayType.clear, .cloudy, .noProduction].compactMap { type -> String? in
            guard let count = counts[type], count > 0 else { return nil }
            return "\(count) \(SolarSystemColors.name(type))"
        } + ((counts[nil] ?? 0) > 0 ? ["\(counts[nil] ?? 0) not sorted yet"] : [])
        return "Week of \(Self.shortDate(starts[index])): " + parts.joined(separator: ", ")
    }

    static func shortDate(_ day: String) -> String {
        var strategy = Date.ISO8601FormatStyle().year().month().day()
        strategy.timeZone = .gmt
        guard let date = try? Date(day, strategy: strategy) else { return day }
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted).year(.omitted)
        style.timeZone = .gmt
        return date.formatted(style)
    }
}
