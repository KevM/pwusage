import FoundationEssentials

private struct InputBucket: Decodable {
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

@_cdecl("bill_allocate")
func billAllocate(_ byteCount: Int32) -> UnsafeMutableRawPointer {
    .allocate(byteCount: Int(byteCount), alignment: MemoryLayout<Double>.alignment)
}

@_cdecl("bill_free")
func billFree(_ pointer: UnsafeMutableRawPointer) {
    pointer.deallocate()
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
        let buckets = try JSONDecoder().decode([InputBucket].self, from: data)
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
