import Foundation

/// Country outlines bundled with the app, so a site's country is found on the device and its
/// coordinates never leave the phone. Built from Natural Earth's public-domain 1:50m Admin 0
/// countries by `cmd/ios-app/make-country-boundaries.py`, which documents the file format.
public struct CountryBoundaries: Sendable {
    struct Point: Equatable, Sendable {
        let longitude: Double
        let latitude: Double
    }

    struct Box: Equatable, Sendable {
        var minLongitude: Double
        var maxLongitude: Double
        var minLatitude: Double
        var maxLatitude: Double

        init(points: [Point]) {
            minLongitude = points.map(\.longitude).min() ?? 0
            maxLongitude = points.map(\.longitude).max() ?? 0
            minLatitude = points.map(\.latitude).min() ?? 0
            maxLatitude = points.map(\.latitude).max() ?? 0
        }

        func contains(_ point: Point, latitudeMargin: Double = 0, longitudeMargin: Double = 0) -> Bool {
            point.latitude >= minLatitude - latitudeMargin && point.latitude <= maxLatitude + latitudeMargin
                && point.longitude >= minLongitude - longitudeMargin
                && point.longitude <= maxLongitude + longitudeMargin
        }
    }

    struct Ring: Sendable {
        let points: [Point]
        let box: Box
    }

    struct Country: Sendable {
        /// ISO 3166-1 alpha-2.
        let code: String
        let rings: [Ring]
        let box: Box
    }

    public enum LoadError: Error, Equatable, Sendable {
        case missingResource
        case malformed
    }

    let countries: [Country]

    public init(data: Data) throws {
        var reader = BoundaryReader(data: data)
        guard try reader.bytes(4) == Array("PWCB".utf8), try reader.uint8() == 1 else {
            throw LoadError.malformed
        }
        let count = Int(try reader.uint16())
        var countries: [Country] = []
        countries.reserveCapacity(count)
        for _ in 0 ..< count {
            guard let code = String(bytes: try reader.bytes(2), encoding: .ascii) else { throw LoadError.malformed }
            let ringCount = Int(try reader.uint32())
            var rings: [Ring] = []
            for _ in 0 ..< ringCount {
                let points = try reader.points(count: Int(try reader.uint32()))
                rings.append(Ring(points: points, box: Box(points: points)))
            }
            let allPoints = rings.flatMap(\.points)
            countries.append(Country(code: code, rings: rings, box: Box(points: allPoints)))
        }
        guard reader.isAtEnd else { throw LoadError.malformed }
        self.countries = countries
    }

    public static func bundled(in bundle: Bundle = .main) throws -> Self {
        guard let url = bundle.url(forResource: "country-boundaries", withExtension: "bin") else {
            throw LoadError.missingResource
        }
        return try Self(data: Data(contentsOf: url, options: .mappedIfSafe))
    }

    /// The country whose outline contains `point`, by the even-odd rule across its rings.
    func country(containing point: Point) -> String? {
        countries.first { country in
            guard country.box.contains(point) else { return false }
            var inside = false
            for ring in country.rings where ring.box.contains(point) && Self.ring(ring.points, contains: point) {
                inside.toggle()
            }
            return inside
        }?.code
    }

    /// Countries whose outline passes within `kilometers` of `point`, nearest first.
    func countries(within kilometers: Double, of point: Point) -> [String] {
        let latitudeMargin = kilometers / Self.kilometersPerDegreeLatitude
        let longitudeScale = Self.kilometersPerDegreeLongitude * max(cos(point.latitude * .pi / 180), 0.01)
        let longitudeMargin = kilometers / longitudeScale
        return countries.compactMap { country -> (String, Double)? in
            guard country.box.contains(point, latitudeMargin: latitudeMargin, longitudeMargin: longitudeMargin) else {
                return nil
            }
            let nearby = country.rings.filter {
                $0.box.contains(point, latitudeMargin: latitudeMargin, longitudeMargin: longitudeMargin)
            }
            let distance = nearby.map { Self.distance(from: point, to: $0.points) }.min() ?? .infinity
            return distance <= kilometers ? (country.code, distance) : nil
        }
        .sorted { $0.1 < $1.1 }
        .map(\.0)
    }

    private static let kilometersPerDegreeLatitude = 110.574
    private static let kilometersPerDegreeLongitude = 111.32

    private static func ring(_ points: [Point], contains point: Point) -> Bool {
        var inside = false
        var previous = points.count - 1
        for index in points.indices {
            let current = points[index]
            let last = points[previous]
            if (current.latitude > point.latitude) != (last.latitude > point.latitude) {
                let crossing = (last.longitude - current.longitude) * (point.latitude - current.latitude)
                    / (last.latitude - current.latitude) + current.longitude
                if point.longitude < crossing { inside.toggle() }
            }
            previous = index
        }
        return inside
    }

    /// Shortest distance in kilometers from `point` to the ring's edges, on a local flat
    /// projection; accurate enough at the few-kilometer scale of the border margin.
    private static func distance(from point: Point, to ring: [Point]) -> Double {
        let scale = cos(point.latitude * .pi / 180) * kilometersPerDegreeLongitude
        func project(_ other: Point) -> (x: Double, y: Double) {
            var longitudeDelta = other.longitude - point.longitude
            if longitudeDelta > 180 { longitudeDelta -= 360 }
            if longitudeDelta < -180 { longitudeDelta += 360 }
            return (longitudeDelta * scale, (other.latitude - point.latitude) * kilometersPerDegreeLatitude)
        }
        var nearest = Double.infinity
        for index in ring.indices.dropFirst() {
            let start = project(ring[index - 1])
            let end = project(ring[index])
            let deltaX = end.x - start.x
            let deltaY = end.y - start.y
            let lengthSquared = deltaX * deltaX + deltaY * deltaY
            let fraction = lengthSquared > 0
                ? min(max(-(start.x * deltaX + start.y * deltaY) / lengthSquared, 0), 1) : 0
            let closestX = start.x + fraction * deltaX
            let closestY = start.y + fraction * deltaY
            nearest = min(nearest, (closestX * closestX + closestY * closestY).squareRoot())
        }
        return nearest
    }
}

private struct BoundaryReader {
    let data: Data
    private var offset: Int

    init(data: Data) {
        self.data = data
        offset = data.startIndex
    }

    var isAtEnd: Bool { offset == data.endIndex }

    mutating func bytes(_ count: Int) throws -> [UInt8] {
        guard count >= 0, data.endIndex - offset >= count else { throw CountryBoundaries.LoadError.malformed }
        defer { offset += count }
        return Array(data[offset ..< offset + count])
    }

    mutating func uint8() throws -> UInt8 { try bytes(1)[0] }

    mutating func uint16() throws -> UInt16 {
        try integer(UInt16.self)
    }

    mutating func uint32() throws -> UInt32 {
        try integer(UInt32.self)
    }

    mutating func points(count: Int) throws -> [CountryBoundaries.Point] {
        let byteCount = count * 8
        guard count >= 0, data.endIndex - offset >= byteCount else {
            throw CountryBoundaries.LoadError.malformed
        }
        let slice = data[offset ..< offset + byteCount]
        offset += byteCount
        return slice.withUnsafeBytes { buffer in
            (0 ..< count).map { index in
                let longitude = Int32(littleEndian: buffer.loadUnaligned(fromByteOffset: index * 8, as: Int32.self))
                let latitude = Int32(
                    littleEndian: buffer.loadUnaligned(fromByteOffset: index * 8 + 4, as: Int32.self)
                )
                return CountryBoundaries.Point(
                    longitude: Double(longitude) / 100_000, latitude: Double(latitude) / 100_000
                )
            }
        }
    }

    private mutating func integer<Value: FixedWidthInteger & UnsignedInteger>(_: Value.Type) throws -> Value {
        let raw = try bytes(MemoryLayout<Value>.size)
        return raw.reversed().reduce(Value.zero) { ($0 << 8) | Value($1) }
    }
}
