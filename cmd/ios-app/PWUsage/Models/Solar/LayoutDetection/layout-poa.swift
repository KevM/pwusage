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

    /// Diffuse IAM linearly interpolated between 0.1° points, so the fit sees a smooth tilt response.
    static func diffuseIamSmooth(_ tilt: Double) -> DiffuseIam {
        let low = floor(tilt * 10) / 10
        let fraction = (tilt - low) * 10
        let lower = diffuseIam(low)
        if fraction < 1e-9 { return lower }
        let upper = diffuseIam(low + 0.1)
        return DiffuseIam(
            sky: lower.sky + (upper.sky - lower.sky) * fraction,
            ground: lower.ground + (upper.ground - lower.ground) * fraction)
    }

    /// Smooth min(x, 1) with scale `scale` (reference `_softmin`).
    static func softmin(_ x: Double, scale: Double = 0.01) -> Double {
        let z = (x - 1) / scale
        let logAddExp = z > 0 ? z + log1p(exp(-z)) : log1p(exp(z))
        return x - scale * logAddExp
    }

    /// Effective POA irradiance divided by 1000 (kW per kW of effective size) for every row of
    /// `sun`, for one plane (reference `poaColumn`). `smooth` uses the interpolated diffuse IAM.
    static func poaColumn(_ sun: LayoutSunArrays, azimuth: Double, tilt: Double, smooth: Bool = false) -> [Double] {
        let clampedTilt = min(max(tilt, 0), 89)
        let cosTilt = cos(clampedTilt * radians)
        let sinTilt = sin(clampedTilt * radians)
        let cosAzimuth = cos(azimuth * radians)
        let sinAzimuth = sin(azimuth * radians)
        let diffuse = smooth ? diffuseIamSmooth(clampedTilt) : diffuseIam(clampedTilt)
        let isotropicFactor = 0.5 * (1 + cosTilt)
        let groundFactor = albedo * (1 - cosTilt) * 0.5 * diffuse.ground
        let n = refractiveIndex
        let extinction = 4 * extinctionDepthMetres
        let normalReflectance = square((1 - n) / (1 + n))
        let norm0 = 2 * (1 - normalReflectance) * exp(-extinction)
        var out = [Double](repeating: 0, count: sun.count)
        for i in 0 ..< sun.count {
            guard sun.ghi[i] > 0 else { continue }
            var c = cosTilt * sun.cosZ[i] + sinTilt * sun.sinZ[i] * (sun.cosSaz[i] * cosAzimuth + sun.sinSaz[i] * sinAzimuth)
            c = c > 1 ? 1 : (c < -1 ? -1 : c)
            var beam = 0.0
            if c > 0 {
                let sin2 = sqrt(1 - c * c) / n
                let cos2 = sqrt(1 - sin2 * sin2)
                let reflectanceS = square((c - n * cos2) / (c + n * cos2))
                let reflectanceP = square((cos2 - n * c) / (cos2 + n * c))
                beam = sun.dni[i] * c * ((2 - reflectanceS - reflectanceP) * exp(-extinction / cos2) / norm0)
            }
            let anisotropy = sun.anis[i]
            let isotropic = sun.dhi[i] * (1 - anisotropy) * isotropicFactor
            let circumsolar = c > 0 ? sun.dhi[i] * anisotropy * c / sun.rbDen[i] : 0
            var effective = beam + (max(isotropic, 0) + max(circumsolar, 0)) * diffuse.sky + sun.ghi[i] * groundFactor
            if effective < 0 { effective = 0 }
            out[i] = effective * (1 - temperatureCoefficient * effective / 1000) / (1 - temperatureCoefficient)
                * sun.tfac[i] / 1000
        }
        return out
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

/// Struct-of-arrays sun geometry for fast per-plane columns, one entry per row (reference `toSunArrays`).
struct LayoutSunArrays: Sendable {
    let cosZ: [Double]
    let sinZ: [Double]
    let cosSaz: [Double]
    let sinSaz: [Double]
    let dni: [Double]
    let ghi: [Double]
    let dhi: [Double]
    let anis: [Double]
    let rbDen: [Double]
    let tfac: [Double]

    var count: Int { cosZ.count }

    init(suns: [LayoutSunSample]) {
        let radiansPerDegree = Double.pi / 180
        cosZ = suns.map { cos($0.apparentZenith * radiansPerDegree) }
        sinZ = suns.map { sin($0.apparentZenith * radiansPerDegree) }
        cosSaz = suns.map { cos($0.azimuth * radiansPerDegree) }
        sinSaz = suns.map { sin($0.azimuth * radiansPerDegree) }
        dni = suns.map(\.dni)
        ghi = suns.map(\.ghi)
        dhi = suns.map(\.dhi)
        anis = suns.map { $0.dniExtra > 0 ? $0.dni / $0.dniExtra : 0 }
        rbDen = cosZ.map { max($0, 0.01745) }
        tfac = suns.map(\.ambientFactor)
    }

    private init(
        cosZ: [Double], sinZ: [Double], cosSaz: [Double], sinSaz: [Double], dni: [Double], ghi: [Double],
        dhi: [Double], anis: [Double], rbDen: [Double], tfac: [Double]
    ) {
        self.cosZ = cosZ
        self.sinZ = sinZ
        self.cosSaz = cosSaz
        self.sinSaz = sinSaz
        self.dni = dni
        self.ghi = ghi
        self.dhi = dhi
        self.anis = anis
        self.rbDen = rbDen
        self.tfac = tfac
    }

    /// The rows at `indices`, in that order.
    func subset(_ indices: [Int]) -> LayoutSunArrays {
        func pick(_ values: [Double]) -> [Double] { indices.map { values[$0] } }
        return LayoutSunArrays(
            cosZ: pick(cosZ), sinZ: pick(sinZ), cosSaz: pick(cosSaz), sinSaz: pick(sinSaz), dni: pick(dni),
            ghi: pick(ghi), dhi: pick(dhi), anis: pick(anis), rbDen: pick(rbDen), tfac: pick(tfac))
    }
}
