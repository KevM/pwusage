struct SmartShiftSelection: Equatable {
    private(set) var selected: SmartShiftChoiceID
    private(set) var marks: SmartShiftChoiceID
    private(set) var isReturning = false
    private var available: [SmartShiftChoiceID]

    init(choices: [SmartShiftChoice]) {
        available = choices.map(\.id)
        selected = choices.first?.id ?? .now
        marks = selected
    }

    mutating func select(_ id: SmartShiftChoiceID) {
        guard !isReturning, available.contains(id) else { return }
        selected = id
        marks = id
    }

    mutating func beginReturn() {
        guard !isReturning, selected == .now, available.contains(.recommended) else { return }
        selected = .recommended
        isReturning = true
    }

    mutating func landReturn() {
        guard isReturning else { return }
        marks = selected
        isReturning = false
    }

    mutating func reconcile(with choices: [SmartShiftChoice]) {
        available = choices.map(\.id)
        if !available.contains(selected) { selected = available.first ?? .now }
        marks = selected
        isReturning = false
    }
}
