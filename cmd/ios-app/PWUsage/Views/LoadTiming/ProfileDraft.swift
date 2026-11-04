import Foundation

struct ProfileDraft: Identifiable, Equatable {
    var id: String?
    var name: String
    var kind: LoadProfileKind
    var energyKwh: Double
    var durationHours: Double
    var carSettings: CarLoadSettings?

    var sheetID: String { id ?? "new-custom" }
    var isValid: Bool {
        energyKwh.isFinite && energyKwh > 0 && durationHours.isFinite && durationHours > 0 &&
            (kind != .custom || !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) &&
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
    }

    private init() {
        id = nil
        name = "Custom job"
        kind = .custom
        energyKwh = 20
        durationHours = 4
        carSettings = nil
    }

    static func newCustom() -> ProfileDraft { ProfileDraft() }

    /// Whether closing the editor now would lose something the person typed.
    /// A value edited and put back is not a change, so the editor stays one
    /// swipe away unless there is genuinely something to discard.
    func hasUnsavedChanges(from original: ProfileDraft) -> Bool { self != original }
}
