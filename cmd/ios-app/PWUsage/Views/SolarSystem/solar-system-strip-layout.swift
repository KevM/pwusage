import CoreGraphics
import Foundation

/// The calendar strip: one column per week (Sunday first, newest on the right), one row per
/// weekday. Only stored days get cells; the strip grows from the center as older weeks arrive and
/// wraps into two bands when one would not fit.
struct SolarSystemStripLayout: Equatable {
    struct Cell: Equatable {
        let day: String
        let column: Int
        let row: Int
        let band: Int
    }

    struct Label: Equatable {
        let text: String
        let kind: SolarSystemStripLabelKind
        /// Set for the newest end's year, which ends at its column instead of starting there.
        var trailing = false
        let column: Int
        let band: Int
    }

    /// A dot 7.2 points across on an 11.25-point pitch, as in the reveal prototype.
    static let maxCell: CGFloat = 7.2
    static let gapRatio: CGFloat = 0.5625
    /// A label's width in columns, for collision skipping.
    static let monthLabelColumns = 3
    static let yearLabelColumns = 4

    let cells: [Cell]
    let labels: [Label]
    /// Week columns in all, and per band.
    let columns: Int
    let bands: Int
    let columnsPerBand: Int
    /// Cell side and the distance between cell origins.
    let cellSize: CGFloat
    let pitch: CGFloat
    let width: CGFloat
    /// While a new week arrives the strip widens from its center: the columns it spans so far
    /// (eased by the caller), or nil for all of them. Single band only.
    var easedColumns: Double?

    init(days: [String], width: CGFloat) {
        self.width = width
        let indexed = days.compactMap { day in Self.dayNumber(day).map { (day, $0) } }
        guard let oldest = indexed.map(\.1).min(), let newest = indexed.map(\.1).max() else {
            cells = []
            labels = []
            columns = 0
            bands = 1
            columnsPerBand = 0
            cellSize = Self.maxCell
            pitch = Self.maxCell * (1 + Self.gapRatio)
            return
        }
        let firstWeek = Self.week(oldest)
        let columns = Self.week(newest) - firstWeek + 1
        let fullPitch = Self.maxCell * (1 + Self.gapRatio)
        let bands = CGFloat(columns) * fullPitch > width && columns > 1 ? 2 : 1
        let perBand = (columns + bands - 1) / bands
        // Older weeks fill the top band; the newest week ends the last one.
        let offset = perBand * bands - columns
        let pitch = min(fullPitch, width / CGFloat(max(perBand, 1)))
        self.columns = columns
        self.bands = bands
        columnsPerBand = perBand
        self.pitch = pitch
        cellSize = pitch / (1 + Self.gapRatio)
        cells = indexed.map { day, number in
            let slot = Self.week(number) - firstWeek + offset
            return Cell(day: day, column: slot % perBand, row: Self.weekday(number), band: slot / perBand)
        }.sorted { $0.day < $1.day }
        labels = Self.labels(cells: cells, newest: indexed.first { $0.1 == newest }?.0)
    }

    /// This layout part way through widening to its full width.
    func widening(to columns: Double?) -> SolarSystemStripLayout {
        var layout = self
        layout.easedColumns = columns
        return layout
    }

    /// The strip's total size: bands of seven rows, each under a year line and a month line.
    var height: CGFloat { CGFloat(bands) * (7 * pitch + labelHeight) }
    static let labelLine: CGFloat = 14
    var labelHeight: CGFloat { 2 * Self.labelLine }

    /// Left edge of `column`, measured back from the newest column so the newest week stays put
    /// while the strip widens around the center.
    private func left(_ column: Int) -> CGFloat {
        guard bands == 1 else {
            return (width - CGFloat(columnsPerBand) * pitch) / 2 + CGFloat(column) * pitch
        }
        let shown = CGFloat(easedColumns ?? Double(columns))
        let newest = width / 2 + (shown - 2) / 2 * pitch
        return newest - CGFloat(columns - 1 - column) * pitch
    }

    /// A cell's square; bands are centered horizontally.
    func frame(_ cell: Cell) -> CGRect {
        let top = CGFloat(cell.band) * (7 * pitch + labelHeight) + labelHeight
        return CGRect(x: left(cell.column), y: top + CGFloat(cell.row) * pitch, width: cellSize, height: cellSize)
    }

    /// Where a label's text starts (or, for a trailing one, ends), at its line's middle.
    func labelOrigin(_ label: Label) -> CGPoint {
        let top = CGFloat(label.band) * (7 * pitch + labelHeight)
        let line = label.kind == .year ? Self.labelLine / 2 : Self.labelLine * 1.5
        let edge = label.trailing ? left(label.column) + cellSize : left(label.column)
        return CGPoint(x: edge, y: top + line)
    }

    /// The cell under `point`, if any.
    func cell(at point: CGPoint) -> Cell? {
        cells.first { frame($0).insetBy(dx: -pitch * 0.15, dy: -pitch * 0.15).contains(point) }
    }

    // MARK: - Labels

    /// A month label where a month's first day is stored, the year above January's, and the
    /// newest end's year. Each line skips a label overlapping one already placed; the newest end
    /// gives way to a January label of the same year.
    private static func labels(cells: [Cell], newest: String?) -> [Label] {
        var candidates: [Label] = []
        for cell in cells where cell.day.hasSuffix("-01") {
            let month = Int(cell.day.dropFirst(5).prefix(2)) ?? 1
            candidates.append(Label(text: monthName(month), kind: .month, column: cell.column, band: cell.band))
            if month == 1 {
                candidates.append(Label(text: String(cell.day.prefix(4)), kind: .year, column: cell.column,
                                        band: cell.band))
            }
        }
        if let newest, let last = cells.last(where: { $0.day == newest }) {
            candidates.append(Label(
                text: String(newest.prefix(4)), kind: .year, trailing: true, column: last.column, band: last.band))
        }
        var placed: [Label] = []
        for label in candidates {
            let span = columns(label)
            let overlaps = placed.contains { other in
                other.band == label.band && other.kind == label.kind && span.overlaps(columns(other))
            }
            if !overlaps { placed.append(label) }
        }
        return placed.sorted { ($0.band, $0.column) < ($1.band, $1.column) }
    }

    private static func columns(_ label: Label) -> Range<Int> {
        let width = label.kind == .year ? yearLabelColumns : monthLabelColumns
        return label.trailing ? label.column - width + 1 ..< label.column + 1 : label.column ..< label.column + width
    }

    private static func monthName(_ month: Int) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = .current
        let symbols = calendar.shortMonthSymbols
        return symbols.indices.contains(month - 1) ? symbols[month - 1] : ""
    }

    // MARK: - Day numbers

    /// Days since 1970-01-04, a Sunday.
    static func dayNumber(_ day: String) -> Int? {
        SiteLocalDays.days(from: "1970-01-04", to: day, timeZone: .gmt)
    }

    private static func week(_ number: Int) -> Int { Int((Double(number) / 7).rounded(.down)) }
    private static func weekday(_ number: Int) -> Int { ((number % 7) + 7) % 7 }
}

enum SolarSystemStripLabelKind: Equatable { case month, year }
