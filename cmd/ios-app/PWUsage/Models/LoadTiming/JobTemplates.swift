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
        appliance(id: "dishwasher", title: "Wash the dishes", verb: "Wash", symbol: "dishwasher.fill",
                  energyKwh: Defaults.dishwasherKwh, durationHours: Defaults.dishwasherHours),
        appliance(id: "washer", title: "Wash the laundry", verb: "Wash", symbol: "washer.fill",
                  energyKwh: Defaults.washerKwh, durationHours: Defaults.washerHours),
        appliance(id: "dryer", title: "Dry the laundry", verb: "Dry", symbol: "dryer.fill",
                  energyKwh: Defaults.dryerKwh, durationHours: Defaults.dryerHours),
        appliance(id: "washer-dryer-combo", title: "Wash and dry the laundry", verb: "Wash", symbol: "washer.fill",
                  energyKwh: Defaults.comboKwh, durationHours: Defaults.comboHours),
        JobTemplate(id: "custom", title: "Custom job", subtitle: "Pick Small, Medium or Large",
                    symbol: "slider.horizontal.3", draft: .newCustom())
    ]

    private static func appliance(
        id: String, title: String, verb: String, symbol: String, energyKwh: Double, durationHours: Double
    ) -> JobTemplate {
        let energy = energyKwh.formatted(.number.precision(.fractionLength(0 ... 1)))
        let duration = durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))
        return JobTemplate(
            id: id, title: title, subtitle: "\(energy) kWh · \(duration) hr", symbol: symbol,
            draft: ProfileDraft(name: title, kind: .appliance, energyKwh: energyKwh,
                                durationHours: durationHours, actionVerb: verb))
    }
}
