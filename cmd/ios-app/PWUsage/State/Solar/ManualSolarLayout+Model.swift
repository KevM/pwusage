import Foundation

extension ManualSolarFace {
    var nameplateKw: Double { Double(panelCount) * panelWatts / 1000 }

    var isValid: Bool {
        panelCount > 0 && panelWatts.isFinite && panelWatts > 0
            && azimuthDegrees.map { $0.isFinite && (0 ... 360).contains($0) } ?? true
            && tiltDegrees.map { $0.isFinite && (0 ... 90).contains($0) } ?? true
    }
}

extension ManualSolarSystem {
    /// A system with no install date has always counted.
    func isInstalled(on date: Date) -> Bool {
        installDate.map { $0 <= date } ?? true
    }

    var nameplateKw: Double { faces.reduce(0) { $0 + $1.nameplateKw } }
}

extension ManualSolarLayout {
    /// Panel count times wattage over every face of every system installed by `date`.
    func nameplateKw(on date: Date) -> Double {
        installedSystems(on: date).reduce(0) { $0 + $1.nameplateKw }
    }

    func installedSystems(on date: Date) -> [ManualSolarSystem] {
        systems.filter { $0.isInstalled(on: date) }
    }

    /// Enough to save: a system with at least one face, and sensible numbers on every face.
    var isValid: Bool {
        !systems.isEmpty && systems.allSatisfy { !$0.faces.isEmpty && $0.faces.allSatisfy(\.isValid) }
    }

    /// The faces as the forecast's layout, one plane each, so entered geometry feeds the same
    /// plane-of-array model as a detected one. A face with no direction or tilt takes the largest
    /// detected plane's; with nothing detected there is nothing to fall back on, so no layout.
    /// Capacity here is nameplate: the operational forecast scales it by the fitted factor.
    func solarLayout(detected: DetectedSolarLayout?, on date: Date, detectedAt: Date?) -> SolarLayout? {
        let installed = installedSystems(on: date)
        let fallback = detected?.planes.max { $0.dcKwp < $1.dcKwp }
        var planes: [SolarLayoutPlane] = []
        for face in installed.flatMap(\.faces) {
            guard let azimuth = face.azimuthDegrees ?? fallback?.azimuth,
                  let tilt = face.tiltDegrees ?? fallback?.tilt else { return nil }
            planes.append(SolarLayoutPlane(azimuth: azimuth, tilt: tilt, dcKwp: face.nameplateKw))
        }
        guard !planes.isEmpty, planes.allSatisfy(\.isValid) else { return nil }
        return SolarLayout(
            planes: planes, acClipKw: acClipKw(of: installed, fallback: detected?.acClipKw),
            confidence: .high, detectedAt: detectedAt, isManual: true)
    }

    /// Ratings add up only when every installed system has one; a partial sum would clip too early.
    private func acClipKw(of installed: [ManualSolarSystem], fallback: Double?) -> Double? {
        let ratings = installed.compactMap(\.inverterAcKw).filter { $0 > 0 }
        guard !installed.isEmpty, ratings.count == installed.count else { return fallback }
        return ratings.reduce(0, +)
    }
}
