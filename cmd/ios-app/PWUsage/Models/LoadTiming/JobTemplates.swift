import Foundation

/// A starting point for adding a job: a ready-made draft the person can still edit before saving.
struct JobTemplate: Identifiable, Equatable {
    let id: String
    let title: String
    let subtitle: String
    let symbol: String
    let draft: ProfileDraft
}

/// The starter list is data: adding a template is adding an entry here.
enum JobTemplates {
    private typealias Defaults = LoadProfileStore.Defaults

    static let all: [JobTemplate] = [
        JobTemplate(id: "ev", title: "Electric car", subtitle: "Battery size, charge now and target",
                    symbol: "car.fill", draft: .newCar()),
        appliance(id: "dishwasher", symbol: "dishwasher.fill", draft: ProfileDraft(
            name: "Wash the dishes", kind: .appliance, energyKwh: Defaults.dishwasherKwh,
            durationHours: Defaults.dishwasherHours)),
        appliance(id: "washer", symbol: "washer.fill", draft: ProfileDraft(
            name: "Wash the laundry", kind: .appliance, energyKwh: Defaults.washerKwh,
            durationHours: Defaults.washerHours)),
        appliance(id: "dryer", symbol: "dryer.fill", draft: ProfileDraft(
            name: "Dry the laundry", kind: .appliance, energyKwh: Defaults.dryerKwh,
            durationHours: Defaults.dryerHours)),
        appliance(id: "washer-dryer-combo", symbol: "washer.fill", draft: ProfileDraft(
            name: "Wash and dry the laundry", kind: .appliance, energyKwh: Defaults.comboKwh,
            durationHours: Defaults.comboHours)),
        JobTemplate(id: "custom", title: "Custom job", subtitle: "Pick Small, Medium or Large",
                    symbol: "slider.horizontal.3", draft: .newCustom())
    ]

    private static func appliance(id: String, symbol: String, draft: ProfileDraft) -> JobTemplate {
        let energy = draft.energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))
        let duration = draft.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))
        return JobTemplate(id: id, title: draft.name, subtitle: "\(energy) kWh · \(duration) hr",
                           symbol: symbol, draft: draft)
    }
}
