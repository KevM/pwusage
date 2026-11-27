#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

/// Where a car's charge right now comes from. Today the person sets it by hand; a later vehicle sync
/// can supply its own value and ask the app to stop offering hand edits.
public protocol CarChargeSource {
    /// True when the person sets the charge themselves.
    var isManual: Bool { get }
    /// The charge right now, in percent, or nil when this source has no value for the job.
    func currentCharge(for car: LoadProfile) -> Double?
}

/// The charge as the person last set it.
public struct ManualCarChargeSource: CarChargeSource {
    public init() {}
    public var isManual: Bool { true }

    public func currentCharge(for car: LoadProfile) -> Double? {
        car.kind == .car ? car.carSettings?.initialStateOfCharge : nil
    }
}
