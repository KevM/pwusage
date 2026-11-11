import Foundation

struct ProfileDraft: Identifiable, Equatable {
    var id: String?
    var name: String
    var kind: LoadProfileKind
    var energyKwh: Double
    var durationHours: Double
    var carSettings: CarLoadSettings?
    var size: JobSize?
    var actionVerb: String?

    var sheetID: String { id ?? (kind == .car ? "new-car" : "new-custom") }
    var isValid: Bool {
        energyKwh.isFinite && energyKwh > 0 && durationHours.isFinite && durationHours > 0 &&
            !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            (kind != .car || carSettings.map {
                $0.capacityKwh.isFinite && $0.capacityKwh > 0 && $0.capacityKwh <= LoadProfile.maximumCarCapacityKwh &&
                    (0 ... 100).contains($0.initialStateOfCharge) &&
                    ($0.initialStateOfCharge ... 100).contains($0.targetStateOfCharge)
            } == true)
    }

    init(profile: LoadProfile) {
        id = profile.id
        name = profile.name
        kind = profile.kind
        energyKwh = profile.energyKwh
        durationHours = profile.durationHours
        carSettings = profile.carSettings
        size = profile.size
        actionVerb = profile.actionVerb
    }

    /// A job that doesn't exist yet; the store assigns its id when it is saved.
    init(name: String, kind: LoadProfileKind, energyKwh: Double, durationHours: Double,
         carSettings: CarLoadSettings? = nil, size: JobSize? = nil, actionVerb: String? = nil) {
        id = nil
        self.name = name
        self.kind = kind
        self.energyKwh = energyKwh
        self.durationHours = durationHours
        self.carSettings = carSettings
        self.size = size
        self.actionVerb = actionVerb
    }

    static func newCustom() -> ProfileDraft {
        ProfileDraft(name: "Custom job", kind: .custom, energyKwh: JobSize.medium.defaultEnergyKwh,
                     durationHours: JobSize.medium.defaultDurationHours, size: .medium)
    }

    static func newCar() -> ProfileDraft {
        let defaults = LoadProfileStore.Defaults.self
        return ProfileDraft(
            name: "Car", kind: .car, energyKwh: defaults.carEnergyKwh, durationHours: defaults.carDurationHours,
            carSettings: CarLoadSettings(
                capacityKwh: defaults.carCapacityKwh, initialStateOfCharge: defaults.carInitialSOC,
                targetStateOfCharge: defaults.carTargetSOC, chargingLevel: defaults.carLevel))
    }

    /// Picking a size starts from that size's usual energy and hours; stepping either afterwards leaves it alone.
    func applying(size: JobSize) -> ProfileDraft {
        var resized = self
        resized.size = size
        resized.energyKwh = size.defaultEnergyKwh
        resized.durationHours = size.defaultDurationHours
        return resized
    }

    /// Exact mode: the numbers stay as they are and no size applies, so they can be typed in directly.
    func applyingExact() -> ProfileDraft {
        var exact = self
        exact.size = nil
        return exact
    }

    /// How far the Energy stepper moves: bigger sizes take bigger steps.
    var energyStepKwh: Double { size?.energyStepKwh ?? 0.5 }

    var editorTitle: String {
        guard id == nil else { return "Edit Job" }
        switch kind {
        case .car: return "New Car"
        case .appliance: return "New Job"
        case .custom: return "New Custom Job"
        }
    }

    var newProfile: NewProfile {
        NewProfile(name: name, kind: kind, energyKwh: energyKwh, durationHours: durationHours,
                   carSettings: carSettings, size: size, actionVerb: actionVerb)
    }

    /// Whether closing the editor now would lose something the person typed.
    /// A value edited and put back is not a change, so the editor stays one
    /// swipe away unless there is genuinely something to discard.
    func hasUnsavedChanges(from original: ProfileDraft) -> Bool { self != original }
}
