import Foundation

struct SolarHistoryStoredDay: Codable, Equatable {
    let dayStart: Date
    var slots: [Float?]
    var load: [Float?]?
    var grid: [Float?]?
    var battery: [Float?]?
    var soc: [Float?]?

    init(
        dayStart: Date,
        slots: [Float?],
        load: [Float?]? = nil,
        grid: [Float?]? = nil,
        battery: [Float?]? = nil,
        soc: [Float?]? = nil
    ) {
        self.dayStart = dayStart
        self.slots = slots
        self.load = load
        self.grid = grid
        self.battery = battery
        self.soc = soc
    }
}

/// The site's sync state in `<hash>.json`. Days live in one file per year (`SolarHistoryYearFile`); a
/// store written before that still carries them here, is read as is, and moves on its next save.
struct SolarHistoryPersisted: Codable {
    var timeZone: String?
    var syncedThrough: Date?
    var syncedAt: Date?
    var isEnabled: Bool?
    var days: [SolarHistoryStoredDay] = []
    /// Years whose file must be rewritten at the next save. Never encoded.
    var dirtyYears: Set<Int> = []

    private enum CodingKeys: String, CodingKey { case timeZone, syncedThrough, syncedAt, isEnabled, days }

    init() {}

    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        timeZone = try values.decodeIfPresent(String.self, forKey: .timeZone)
        syncedThrough = try values.decodeIfPresent(Date.self, forKey: .syncedThrough)
        syncedAt = try values.decodeIfPresent(Date.self, forKey: .syncedAt)
        isEnabled = try values.decodeIfPresent(Bool.self, forKey: .isEnabled)
        days = try values.decodeIfPresent([SolarHistoryStoredDay].self, forKey: .days) ?? []
    }

    /// Days are not written here: they go to the year files.
    func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(timeZone, forKey: .timeZone)
        try values.encodeIfPresent(syncedThrough, forKey: .syncedThrough)
        try values.encodeIfPresent(syncedAt, forKey: .syncedAt)
        try values.encodeIfPresent(isEnabled, forKey: .isEnabled)
    }
}

/// One calendar year of days, with slots as little-endian Float32 (NaN for no reading): a ten-year
/// store is a few megabytes, and saving a day rewrites only its year.
struct SolarHistoryYearFile: Codable {
    var year: Int
    var dayStarts: [Date]
    var counts: [Int]
    var slots: Data
    var flowMask: [UInt8]?
    var load: Data?
    var grid: Data?
    var battery: Data?
    var soc: Data?

    init(year: Int, days: [SolarHistoryStoredDay]) {
        self.year = year
        dayStarts = days.map(\.dayStart)
        counts = days.map(\.slots.count)
        slots = Self.encodeSeries(days.map(\.slots), capacity: counts.reduce(0, +))
        var mask = Array(repeating: UInt8(0), count: days.count)
        let loadData = Self.encodeOptionalSeries(days, bit: 1, mask: &mask, series: \.load)
        let gridData = Self.encodeOptionalSeries(days, bit: 2, mask: &mask, series: \.grid)
        let batteryData = Self.encodeOptionalSeries(days, bit: 4, mask: &mask, series: \.battery)
        let socData = Self.encodeOptionalSeries(days, bit: 8, mask: &mask, series: \.soc)
        if mask.contains(where: { $0 != 0 }) {
            flowMask = mask
            load = loadData
            grid = gridData
            battery = batteryData
            soc = socData
        }
    }

    var days: [SolarHistoryStoredDay] {
        var solarOffset = 0
        var loadCursor = SeriesCursor(data: load, mask: flowMask, bit: 1)
        var gridCursor = SeriesCursor(data: grid, mask: flowMask, bit: 2)
        var batteryCursor = SeriesCursor(data: battery, mask: flowMask, bit: 4)
        var socCursor = SeriesCursor(data: soc, mask: flowMask, bit: 8)
        return zip(dayStarts, counts).enumerated().map { index, pair in
            let (dayStart, count) = pair
            let solar = Self.decodeSlots(from: slots, offset: &solarOffset, count: count)
            return SolarHistoryStoredDay(
                dayStart: dayStart,
                slots: solar,
                load: loadCursor.next(at: index, count: count),
                grid: gridCursor.next(at: index, count: count),
                battery: batteryCursor.next(at: index, count: count),
                soc: socCursor.next(at: index, count: count)
            )
        }
    }

    private struct SeriesCursor {
        let data: Data?
        let mask: [UInt8]?
        let bit: UInt8
        var offset = 0

        mutating func next(at index: Int, count: Int) -> [Float?]? {
            guard let data, let mask, index < mask.count, (mask[index] & bit) != 0 else { return nil }
            return SolarHistoryYearFile.decodeSlots(from: data, offset: &offset, count: count)
        }
    }

    private static func encodeOptionalSeries(
        _ days: [SolarHistoryStoredDay],
        bit: UInt8,
        mask: inout [UInt8],
        series: KeyPath<SolarHistoryStoredDay, [Float?]?>
    ) -> Data? {
        var present: [[Float?]] = []
        var total = 0
        for (index, day) in days.enumerated() {
            guard let values = day[keyPath: series] else { continue }
            mask[index] |= bit
            present.append(values)
            total += values.count
        }
        return present.isEmpty ? nil : encodeSeries(present, capacity: total)
    }

    private static func encodeSeries(_ seriesList: [[Float?]], capacity: Int) -> Data {
        var data = Data(capacity: capacity * MemoryLayout<UInt32>.size)
        for series in seriesList {
            for slot in series {
                var bits = (slot ?? .nan).bitPattern.littleEndian
                withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
            }
        }
        return data
    }

    private static func decodeSlots(from data: Data, offset: inout Int, count: Int) -> [Float?] {
        let values = (0 ..< count).map { index -> Float? in
            let position = (offset + index) * MemoryLayout<UInt32>.size
            guard position + MemoryLayout<UInt32>.size <= data.count else { return nil }
            let bits = data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: position, as: UInt32.self) }
            let value = Float(bitPattern: UInt32(littleEndian: bits))
            return value.isNaN ? nil : value
        }
        offset += count
        return values
    }
}

/// Reads and writes one site's year files in a folder.
struct SolarHistoryYearFiles {
    let fileManager: FileManager
    let folder: URL

    /// The calendar year (UTC) whose file holds a day.
    static func year(of dayStart: Date) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar.component(.year, from: dayStart)
    }

    func load() throws -> [SolarHistoryStoredDay] {
        guard fileManager.fileExists(atPath: folder.path) else { return [] }
        let files = try fileManager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
        let decoder = JSONDecoder()
        return try files.flatMap { try decoder.decode(SolarHistoryYearFile.self, from: Data(contentsOf: $0)).days }
    }

    /// Rewrites the years that changed and deletes the files of years with no days left.
    func save(_ state: SolarHistoryPersisted) throws {
        let byYear = Dictionary(grouping: state.days) { Self.year(of: $0.dayStart) }
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        var folderValues = URLResourceValues()
        folderValues.isExcludedFromBackup = true
        var protectedFolder = folder
        try protectedFolder.setResourceValues(folderValues)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: folder.path
        )
        let encoder = JSONEncoder()
        for year in state.dirtyYears.sorted() {
            guard let days = byYear[year] else { continue }
            let file = SolarHistoryYearFile(year: year, days: days.sorted { $0.dayStart < $1.dayStart })
            try encoder.encode(file).write(
                to: folder.appendingPathComponent("\(year).json"),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        }
        for url in try fileManager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            where url.pathExtension == "json" {
            guard let year = Int(url.deletingPathExtension().lastPathComponent), byYear[year] == nil else { continue }
            try fileManager.removeItem(at: url)
        }
    }
}
