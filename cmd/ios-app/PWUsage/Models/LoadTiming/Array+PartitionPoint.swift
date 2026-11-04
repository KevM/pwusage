import Foundation

extension Array {
    /// The first index whose element satisfies `predicate`, for a predicate that is
    /// false then true across the (sorted) array.
    func partitionPoint(where predicate: (Element) -> Bool) -> Int {
        var low = 0, high = count
        while low < high {
            let mid = (low + high) / 2
            if predicate(self[mid]) { high = mid } else { low = mid + 1 }
        }
        return low
    }
}
