import Foundation

enum BillPricing {
    private struct GroupKey: Hashable {
        let planName: String
        let periodName: String
    }

    static func costs(_ buckets: [BillUsageBucket]) -> [Double] {
        var result = Array(repeating: 0.0, count: buckets.count)
        var groupIndices: [GroupKey: [Int]] = [:]

        for (index, bucket) in buckets.enumerated() {
            let key = GroupKey(
                planName: bucket.planName.isEmpty ? "Unknown" : bucket.planName,
                periodName: bucket.periodName.isEmpty ? "Unknown" : bucket.periodName
            )
            groupIndices[key, default: []].append(index)
        }

        for indices in groupIndices.values {
            let imports = indices.reduce(0.0) { $0 + max(buckets[$1].gridWh, 0) }
            let exports = indices.reduce(0.0) { $0 + max(-buckets[$1].gridWh, 0) }
            let net = imports - exports

            for index in indices {
                let bucket = buckets[index]
                if net > 0, bucket.gridWh > 0 {
                    result[index] = (bucket.gridWh / 1000.0) * (net / imports) * bucket.buyRate
                } else if net < 0, bucket.gridWh < 0 {
                    result[index] = (bucket.gridWh / 1000.0) * (-net / exports) * abs(bucket.sellRate)
                }
            }
        }
        return result
    }
}
