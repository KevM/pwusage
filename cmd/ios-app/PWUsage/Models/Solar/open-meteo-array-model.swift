import Foundation

/// The backtest's array model: Hay-Davies sky + 0.25-albedo ground diffuse,
/// physical beam IAM, 14% losses, then a shared hard inverter clip.
/// Weather is hourly mean irradiance; callers evaluate geometry at the hour's midpoint.
enum OpenMeteoArrayModel {
    enum Error: Swift.Error, Equatable { case invalidInput }

    // Radiation components stay explicit at the weather/model boundary.
    // swiftlint:disable:next function_parameter_count
    static func powerKw(
        at midpoint: Date, ghi: Double, dni: Double, dhi: Double,
        layout: SolarLayout, location: SolarHomeLocation
    ) throws -> Double {
        guard midpoint.timeIntervalSince1970.isFinite, location.isValid,
              [ghi, dni, dhi].allSatisfy({ $0.isFinite && $0 >= 0 }),
              (1 ... 3).contains(layout.planes.count), layout.planes.allSatisfy(\.isValid),
              layout.acClipKw.map({ $0.isFinite && $0 > 0 }) ?? true else { throw Error.invalidInput }
        let sun = SolarPosition.at(midpoint, latitude: location.latitude, longitude: location.longitude)
        let total = layout.planes.reduce(0.0) { result, plane in
            result + plane.dcKwp * effectiveIrradiance(plane, sun: sun, ghi: ghi, dni: dni, dhi: dhi) / 1000 * 0.86
        }
        guard total.isFinite else { throw Error.invalidInput }
        return layout.acClipKw.map { min(total, $0) } ?? total
    }

    private static func effectiveIrradiance(
        _ plane: SolarLayoutPlane, sun: SolarPosition, ghi: Double, dni: Double, dhi: Double
    ) -> Double {
        let radians = Double.pi / 180
        let tilt = plane.tilt * radians
        let zenith = sun.apparentZenith * radians
        let projection = min(1, max(-1, cos(tilt) * cos(zenith)
                + sin(tilt) * sin(zenith) * cos((sun.azimuth - plane.azimuth) * radians)))
        let beam = max(0, dni * projection) * physicalIam(cosineIncidence: projection)
        let anisotropy = dni / sun.extraterrestrialDni
        let ratio = max(0, projection) / max(cos(zenith), 0.01745)
        let sky = max(0, dhi * (1 - anisotropy) * 0.5 * (1 + cos(tilt)))
            + max(0, dhi * anisotropy * ratio)
        // pvlib get_total_irradiance defaults to albedo=0.25, unlike the detector (0.2).
        let ground = ghi * 0.25 * (1 - cos(tilt)) * 0.5
        return max(0, beam + sky + ground)
    }

    /// pvlib physical IAM: refractive index 1.526, extinction 4/m, glass thickness 0.002m.
    private static func physicalIam(cosineIncidence: Double) -> Double {
        let cosine = max(0, cosineIncidence)
        guard cosine > 0 else { return 0 }
        let index = 1.526
        let transmittedCosine = sqrt(1 - (1 - cosine * cosine) / (index * index))
        let perpendicular = pow((cosine - index * transmittedCosine) / (cosine + index * transmittedCosine), 2)
        let parallel = pow((transmittedCosine - index * cosine) / (transmittedCosine + index * cosine), 2)
        let normalReflection = pow((1 - index) / (1 + index), 2)
        return (2 - perpendicular - parallel) * 0.5 * exp(-0.008 / transmittedCosine)
            / ((1 - normalReflection) * exp(-0.008))
    }
}
