import Foundation

/// One plane of the detector's layout: orientation, tilt and effective (post-IAM, temperature
/// adjusted) size in kW.
struct LayoutPlane: Equatable, Sendable {
    let azimuth: Double
    let tilt: Double
    let effectiveKw: Double
}

/// Plane-of-array model (port of the detector's `poa.ts`): Hay-Davies sky diffuse, ground
/// diffuse at albedo 0.2, physical beam IAM, Marion-integrated diffuse IAM, then the
/// irradiance-dependent temperature prior and the ambient-temperature factor.
enum LayoutPOA {
    static let maxTilt = 50.0

    private static let albedo = 0.2
    private static let temperatureCoefficient = 0.10
    private static let refractiveIndex = 1.526
    private static let extinctionDepthMetres = 0.002
    private static let radians = Double.pi / 180

    /// Plane-of-array output in kW for `planes` under `sun`, summed over planes.
    static func modelKw(sun: LayoutSunSample, planes: [LayoutPlane]) -> Double {
        planes.reduce(0) { total, plane in
            total + plane.effectiveKw * effectiveIrradiance(sun, azimuth: plane.azimuth, tilt: plane.tilt) / 1000
        }
    }

    /// Effective POA irradiance in W/m² for one plane.
    private static func effectiveIrradiance(_ sun: LayoutSunSample, azimuth: Double, tilt: Double) -> Double {
        guard sun.ghi > 0 else { return 0 }
        let clampedTilt = min(max(tilt, 0), 89)
        let components = components(sun, azimuth: azimuth, tilt: clampedTilt)
        let aoi = acos(cosineAoi(sun, azimuth: azimuth, tilt: clampedTilt)) / radians
        let diffuse = diffuseIam(clampedTilt)
        var effective = components.direct * physicalIam(aoi)
            + components.skyDiffuse * diffuse.sky
            + components.groundDiffuse * diffuse.ground
        effective = max(effective, 0)
        effective = effective * (1 - temperatureCoefficient * effective / 1000) / (1 - temperatureCoefficient)
        return effective * sun.ambientFactor
    }

    private static func cosineAoi(_ sun: LayoutSunSample, azimuth: Double, tilt: Double) -> Double {
        let zenith = sun.apparentZenith * radians
        let tiltRadians = tilt * radians
        let projection = cos(tiltRadians) * cos(zenith)
            + sin(tiltRadians) * sin(zenith) * cos((sun.azimuth - azimuth) * radians)
        return min(1, max(-1, projection))
    }

    /// Hay-Davies POA components before IAM and temperature.
    private static func components(_ sun: LayoutSunSample, azimuth: Double, tilt: Double) -> PlaneComponents {
        let cosineAoi = cosineAoi(sun, azimuth: azimuth, tilt: tilt)
        let direct = max(sun.dni * cosineAoi, 0)
        let circumsolarRatio = max(cosineAoi, 0) / max(cos(sun.apparentZenith * radians), 0.01745)
        let anisotropy = sun.dniExtra > 0 ? sun.dni / sun.dniExtra : 0
        let tiltCosine = cos(tilt * radians)
        let isotropic = max(sun.dhi * (1 - anisotropy) * 0.5 * (1 + tiltCosine), 0)
        let circumsolar = max(sun.dhi * anisotropy * circumsolarRatio, 0)
        let groundDiffuse = sun.ghi * albedo * (1 - tiltCosine) * 0.5
        return PlaneComponents(direct: direct, skyDiffuse: isotropic + circumsolar, groundDiffuse: groundDiffuse)
    }

    /// Physical (Fresnel plus Beer-Lambert) IAM for AOI in degrees, as pvlib `iam.physical` with
    /// n = 1.526, K = 4 and L = 0.002 (no AR coating).
    static func physicalIam(_ aoi: Double) -> Double {
        let index = refractiveIndex
        let extinction = 4 * extinctionDepthMetres
        let cos1 = max(0, cos(aoi * radians))
        let sin1 = sqrt(1 - cos1 * cos1)
        let sin2 = sin1 / index
        let cos2 = sqrt(1 - sin2 * sin2)
        let reflectanceS = square((cos1 - index * cos2) / (cos1 + index * cos2))
        let reflectanceP = square((cos2 - index * cos1) / (cos2 + index * cos1))
        let normalReflectance = square((1 - index) / (1 + index))
        guard cos1 > 0 else { return 0 }
        let attenuation = exp(-extinction / cos2)
        return ((1 - reflectanceS) * attenuation + (1 - reflectanceP) * attenuation) / 2
            / ((1 - normalReflectance) * exp(-extinction))
    }

    /// Marion-integrated diffuse IAM for the sky and ground terms at `tilt`, cached by tilt to 0.1°.
    static func diffuseIam(_ tilt: Double) -> DiffuseIam {
        let key = (tilt * 10).rounded() / 10
        return diffuseCache.value(for: key) {
            DiffuseIam(sky: marionIntegrate(key, region: .sky), ground: marionIntegrate(key, region: .ground))
        }
    }

    private enum Region { case sky, ground }

    private static func marionIntegrate(_ tilt: Double, region: Region) -> Double {
        let segments = 180
        let beta = tilt * radians
        let step = Double.pi / Double(segments)
        let cosBeta = cos(beta)
        let sinBeta = sin(beta)
        let cosPsi = (0 ..< 2 * segments).map { cos(Double($0) * step + 0.5 * step) }
        var numerator = 0.0
        var denominator = 0.0
        for segment in 0 ..< segments {
            let phi1 = Double(segment) * step
            switch region {
            case .sky where phi1 + step > Double.pi / 2 + 1e-12: continue
            case .ground where phi1 < Double.pi / 2: continue
            default: break
            }
            let phiAverage = phi1 + 0.5 * step
            let dAs = step * (cos(phi1) - cos(phi1 + step))
            let term1 = cosBeta * cos(phiAverage)
            let term2 = sinBeta * sin(phiAverage)
            for sample in 0 ..< 2 * segments {
                let cosineAoi = term1 + term2 * cosPsi[sample]
                guard cosineAoi > 0 else { continue }
                let weight = cosineAoi * dAs
                numerator += physicalIam(acos(min(1, cosineAoi)) / radians) * weight
                denominator += weight
            }
        }
        return denominator != 0 ? numerator / denominator : 0
    }

    private static func square(_ value: Double) -> Double { value * value }

    private static let diffuseCache = DiffuseIamCache()
}

/// Hay-Davies POA components in W/m² before IAM and temperature.
private struct PlaneComponents {
    let direct: Double
    let skyDiffuse: Double
    let groundDiffuse: Double
}

/// Marion-integrated diffuse IAM for the sky and ground regions of a tilted plane.
struct DiffuseIam: Equatable, Sendable {
    let sky: Double
    let ground: Double
}

/// Lock-guarded tilt cache for the Marion integration, which is the expensive part of the model.
private final class DiffuseIamCache: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [Double: DiffuseIam] = [:]

    func value(for key: Double, compute: () -> DiffuseIam) -> DiffuseIam {
        lock.lock()
        if let hit = entries[key] {
            lock.unlock()
            return hit
        }
        lock.unlock()
        let computed = compute()
        lock.lock()
        entries[key] = computed
        lock.unlock()
        return computed
    }
}
