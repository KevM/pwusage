import FoundationEssentials

private struct SiteTimeZonePayload: Decodable {
    let identifier: String
    let initialOffsetSeconds: Int
    let transitions: [SiteTimeZone.Transition]

    var siteTimeZone: SiteTimeZone {
        SiteTimeZone(
            identifier: identifier,
            initialOffsetSeconds: initialOffsetSeconds,
            transitions: transitions
        )
    }
}

private func makeDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .secondsSince1970
    return decoder
}

private func makeEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .secondsSince1970
    return encoder
}

private func encodeResponse<T: Encodable>(
    _ value: T,
    outPtr: UnsafeMutablePointer<Int32>,
    outBytes: UnsafeMutablePointer<Int32>
) throws -> Int32 {
    let data = try makeEncoder().encode(value)
    let pointer = pwAllocate(Int32(max(data.count, 1)))
    if !data.isEmpty {
        data.copyBytes(to: pointer.assumingMemoryBound(to: UInt8.self), count: data.count)
    }
    outPtr.pointee = Int32(Int(bitPattern: pointer))
    outBytes.pointee = Int32(data.count)
    return 0
}

private func runJsonBridge<Request: Decodable, Response: Encodable>(
    _ input: UnsafeRawPointer,
    _ byteCount: Int32,
    _ outPtr: UnsafeMutablePointer<Int32>,
    _ outBytes: UnsafeMutablePointer<Int32>,
    body: (Request) throws -> Response
) -> Int32 {
    outPtr.pointee = 0
    outBytes.pointee = 0
    do {
        let data = Data(bytes: input, count: Int(byteCount))
        let request = try makeDecoder().decode(Request.self, from: data)
        let response = try body(request)
        return try encodeResponse(response, outPtr: outPtr, outBytes: outBytes)
    } catch {
        return 1
    }
}

@_cdecl("pw_allocate")
func pwAllocate(_ byteCount: Int32) -> UnsafeMutableRawPointer {
    .allocate(byteCount: max(Int(byteCount), 1), alignment: MemoryLayout<Double>.alignment)
}

@_cdecl("pw_free")
func pwFree(_ pointer: UnsafeMutableRawPointer) {
    pointer.deallocate()
}

// MARK: - BillPricing

private struct BillInputBucket: Decodable {
    let planName: String
    let periodName: String
    let gridWh: Double
    let buyRate: Double
    let sellRate: Double

    var pricingBucket: BillUsageBucket {
        BillUsageBucket(
            planName: planName, periodName: periodName, buyRate: buyRate, sellRate: sellRate,
            gridWh: gridWh, loadWh: 0, solarWh: 0
        )
    }
}

@_cdecl("bill_price")
func billPrice(
    _ input: UnsafeRawPointer,
    _ byteCount: Int32,
    _ output: UnsafeMutablePointer<Double>,
    _ outputCount: Int32
) -> Int32 {
    do {
        let data = Data(bytes: input, count: Int(byteCount))
        let buckets = try makeDecoder().decode([BillInputBucket].self, from: data)
        guard buckets.count == Int(outputCount) else { return 1 }
        let costs = BillPricing.costs(buckets.map(\.pricingBucket))
        for (index, cost) in costs.enumerated() {
            output.advanced(by: index).initialize(to: cost)
        }
        return 0
    } catch {
        return 1
    }
}

// MARK: - SolarLayout

private struct SolarLayoutDetectRequest: Decodable {
    let timestamps: [Double]
    let solarWh: [Double]
    let latitude: Double
    let longitude: Double
    let siteTimeZone: SiteTimeZonePayload
    let detectedAt: Date?
}

private struct SolarLayoutDetectResponse: Encodable {
    let result: DetectedSolarLayout
    let forecastLayout: SolarLayout?
    let historyOutlook: SolarLayoutHistoryOutlook
}

@_cdecl("solar_layout_detect")
func solarLayoutDetect(
    _ input: UnsafeRawPointer,
    _ byteCount: Int32,
    _ outPtr: UnsafeMutablePointer<Int32>,
    _ outBytes: UnsafeMutablePointer<Int32>
) -> Int32 {
    runJsonBridge(input, byteCount, outPtr, outBytes) { (req: SolarLayoutDetectRequest) in
        guard req.timestamps.count == req.solarWh.count else {
            throw SolarForecastError.nonFiniteValue
        }
        let samples = zip(req.timestamps, req.solarWh).map {
            (timestamp: Date(timeIntervalSince1970: $0), solarWh: $1)
        }
        let result = try SolarLayoutDetector.detect(
            samples: samples,
            latitude: req.latitude,
            longitude: req.longitude,
            siteTimeZone: req.siteTimeZone.siteTimeZone,
            checkCancellation: {}
        )
        let detectedAt = req.detectedAt ?? Date(timeIntervalSince1970: req.timestamps.last ?? 0)
        return SolarLayoutDetectResponse(
            result: result,
            forecastLayout: SolarLayoutDetector.forecastLayout(result, detectedAt: detectedAt),
            historyOutlook: SolarLayoutDetector.historyOutlook(result)
        )
    }
}

private struct SolarLayoutReadinessRequest: Decodable {
    let timestamps: [Double]
    let solarWh: [Double]
    let latitude: Double
    let longitude: Double
    let siteTimeZone: SiteTimeZonePayload
}

private struct SolarLayoutReadinessResponse: Encodable {
    let producingDays: Int
    let isReady: Bool
    let daysNeeded: Int
}

@_cdecl("solar_layout_readiness")
func solarLayoutReadiness(
    _ input: UnsafeRawPointer,
    _ byteCount: Int32,
    _ outPtr: UnsafeMutablePointer<Int32>,
    _ outBytes: UnsafeMutablePointer<Int32>
) -> Int32 {
    runJsonBridge(input, byteCount, outPtr, outBytes) { (req: SolarLayoutReadinessRequest) in
        guard req.timestamps.count == req.solarWh.count else {
            throw SolarForecastError.nonFiniteValue
        }
        let samples = zip(req.timestamps, req.solarWh).map {
            (timestamp: Date(timeIntervalSince1970: $0), solarWh: $1)
        }
        let readiness = SolarLayoutDetector.readiness(
            samples: samples,
            latitude: req.latitude,
            longitude: req.longitude,
            siteTimeZone: req.siteTimeZone.siteTimeZone
        )
        return SolarLayoutReadinessResponse(
            producingDays: readiness.producingDays,
            isReady: readiness.isReady,
            daysNeeded: readiness.daysNeeded
        )
    }
}

// MARK: - SolarForecast

private struct OpenMeteoForecastRequest: Decodable {
    let weather: OpenMeteoWeather
    let layout: SolarLayout
    let location: SolarHomeLocation
    let windowStart: Date
    let windowEnd: Date
    let siteTimeZone: SiteTimeZonePayload
}

private struct OpenMeteoForecastResponse: Encodable {
    let intervals: [SolarForecastInterval]
}

@_cdecl("solar_forecast_open_meteo")
func solarForecastOpenMeteo(
    _ input: UnsafeRawPointer,
    _ byteCount: Int32,
    _ outPtr: UnsafeMutablePointer<Int32>,
    _ outBytes: UnsafeMutablePointer<Int32>
) -> Int32 {
    runJsonBridge(input, byteCount, outPtr, outBytes) { (req: OpenMeteoForecastRequest) in
        guard req.windowEnd > req.windowStart else {
            throw OpenMeteoClientError.invalidResponse
        }
        let window = DateInterval(start: req.windowStart, end: req.windowEnd)
        let intervals = try req.weather.intervals(
            layout: req.layout,
            location: req.location,
            window: window,
            siteTimeZone: req.siteTimeZone.siteTimeZone
        )
        return OpenMeteoForecastResponse(intervals: intervals)
    }
}

private struct PastForecastHourPayload: Decodable {
    let hourStart: Date
    let energyWh: Double
}

private struct SolarForecastCorrectRequest: Decodable {
    let intervals: [SolarForecastInterval]
    let fetchedAt: Date
    let now: Date
    let siteTimeZone: SiteTimeZonePayload
    let acClipKw: Double?
    let sameDayPastForecast: [PastForecastHourPayload]
    let dayAheadPastForecast: [PastForecastHourPayload]
    let actuals: [MobileSolarActualsHour]
}

private struct ForecastCorrectionDTO: Encodable {
    let hourFactors: [String: Double]
    let fallbackFactor: Double
    let samples: Int

    init(_ correction: SolarForecastCorrection) {
        hourFactors = Dictionary(uniqueKeysWithValues: correction.hourFactors.map { (String($0.key), $0.value) })
        fallbackFactor = correction.fallbackFactor
        samples = correction.samples
    }
}

private struct SolarForecastCorrectResponse: Encodable {
    let sameDay: ForecastCorrectionDTO
    let dayAhead: ForecastCorrectionDTO
    let intervals: [SolarForecastInterval]
}

@_cdecl("solar_forecast_correct")
func solarForecastCorrect(
    _ input: UnsafeRawPointer,
    _ byteCount: Int32,
    _ outPtr: UnsafeMutablePointer<Int32>,
    _ outBytes: UnsafeMutablePointer<Int32>
) -> Int32 {
    runJsonBridge(input, byteCount, outPtr, outBytes) { (req: SolarForecastCorrectRequest) in
        let zone = req.siteTimeZone.siteTimeZone
        let sameDayMap = Dictionary(
            req.sameDayPastForecast.map { ($0.hourStart, $0.energyWh) },
            uniquingKeysWith: { _, latest in latest }
        )
        let dayAheadMap = Dictionary(
            req.dayAheadPastForecast.map { ($0.hourStart, $0.energyWh) },
            uniquingKeysWith: { _, latest in latest }
        )
        let sameDay = SolarForecastCorrection.derive(
            pastForecastWh: sameDayMap, actuals: req.actuals, siteTimeZone: zone, now: req.now
        )
        let dayAhead = SolarForecastCorrection.derive(
            pastForecastWh: dayAheadMap, actuals: req.actuals, siteTimeZone: zone, now: req.now
        )
        let cohort = SolarForecastCohortCorrection(sameDay: sameDay, dayAhead: dayAhead)
        let corrected = cohort.apply(
            to: req.intervals, fetchedAt: req.fetchedAt, siteTimeZone: zone, acClipKw: req.acClipKw
        )
        return SolarForecastCorrectResponse(
            sameDay: ForecastCorrectionDTO(sameDay),
            dayAhead: ForecastCorrectionDTO(dayAhead),
            intervals: corrected
        )
    }
}

// MARK: - Smart Shift (LoadTiming)

private struct SmartShiftEvaluateRequest: Decodable {
    let now: Date
    let timing: LoadTiming
    let forecastAvailable: Bool
    let intervals: [SolarForecastInterval]?
    let context: LoadTimingForecastEstimator.PlanningContext?
    let balanceSourceTime: Date?
    let billingCycleEnd: Date
    let currencyCode: String
    let siteTimeZone: SiteTimeZonePayload
    let profiles: [LoadProfile]
}

private struct SmartShiftEvaluationItem: Encodable {
    let profileId: String
    let projection: LoadTimingForecastEstimator.Projection.Kind?
    let forecastUnavailableReason: LoadTimingForecastEstimator.UnavailableReason?
    let comparison: LoadTimingForecastEstimator.Comparison?
    let unavailableReason: LoadTimingForecastEstimator.UnavailableReason?
}

private struct SmartShiftEvaluateResponse: Encodable {
    let evaluations: [SmartShiftEvaluationItem]
}

@_cdecl("smart_shift_evaluate")
func smartShiftEvaluate(
    _ input: UnsafeRawPointer,
    _ byteCount: Int32,
    _ outPtr: UnsafeMutablePointer<Int32>,
    _ outBytes: UnsafeMutablePointer<Int32>
) -> Int32 {
    runJsonBridge(input, byteCount, outPtr, outBytes) { (req: SmartShiftEvaluateRequest) in
        let zone = req.siteTimeZone.siteTimeZone
        let inputs = SmartShiftEvaluationInputs(
            now: req.now,
            timing: req.timing,
            forecast: req.forecastAvailable ? .ready : .none,
            intervals: req.intervals,
            context: req.context,
            balanceSourceTime: req.balanceSourceTime,
            billingCycleEnd: req.billingCycleEnd,
            currencyCode: req.currencyCode,
            timeZone: zone.identifier,
            siteTimeZone: zone
        )
        var capturedForecastReason: LoadTimingForecastEstimator.UnavailableReason?
        let evaluate = SmartShiftEvaluator.evaluator(inputs) { reason in
            capturedForecastReason = reason
            return reason.rawValue
        }
        let items = req.profiles.map { profile -> SmartShiftEvaluationItem in
            capturedForecastReason = nil
            let evaluation = evaluate(profile)
            let forecastReason: LoadTimingForecastEstimator.UnavailableReason? =
                if case .unusable = evaluation.forecast { capturedForecastReason } else { nil }
            return SmartShiftEvaluationItem(
                profileId: profile.id,
                projection: evaluation.projection,
                forecastUnavailableReason: forecastReason,
                comparison: evaluation.result.comparison,
                unavailableReason: evaluation.result.unavailableReason
            )
        }
        return SmartShiftEvaluateResponse(evaluations: items)
    }
}
