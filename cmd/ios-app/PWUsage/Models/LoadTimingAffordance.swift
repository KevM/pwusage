import Foundation

struct LoadTimingAffordance: Equatable {
    enum Choice: String, Equatable {
        case dishwasher
        case laundry
        case car
    }

    enum State: Equatable {
        case allowed(Choice)
        case caution
        case awaitingActiveBalance
    }

    struct Load: Equatable {
        let choice: Choice
        let headroomKwh: Double
    }

    struct UnmetLoad: Equatable {
        let choice: Choice
        let shortfallKwh: Double
    }

    let state: State
    let periodName: String?
    let balanceKwh: Double?
    let choices: [Load]
    let nextUnmet: UnmetLoad?
    let nextCheaper: NextCheaperPeriod?

    static func evaluate(timing: LoadTiming, plannedCarKwh: Double) -> LoadTimingAffordance {
        var choices = [
            Load(choice: .dishwasher, headroomKwh: 5),
            Load(choice: .laundry, headroomKwh: 20),
        ]
        if plannedCarKwh.isFinite, plannedCarKwh > 0 {
            choices.append(Load(
                choice: .car,
                headroomKwh: LoadTimingEstimator.carHeadroomKwh(plannedKwh: plannedCarKwh)
            ))
        }
        choices.sort { lhs, rhs in
            lhs.headroomKwh == rhs.headroomKwh
                ? lhs.choice.rawValue < rhs.choice.rawValue
                : lhs.headroomKwh < rhs.headroomKwh
        }

        guard let active = timing.periods.first(where: \.isActive) else {
            return LoadTimingAffordance(
                state: .awaitingActiveBalance,
                periodName: nil,
                balanceKwh: nil,
                choices: choices,
                nextUnmet: nil,
                nextCheaper: timing.nextCheaper
            )
        }

        let balance = active.cycleNetExportKwh
        let covered = choices.last(where: { balance >= $0.headroomKwh })
        let next = choices.first(where: { balance < $0.headroomKwh }).map {
            UnmetLoad(choice: $0.choice, shortfallKwh: $0.headroomKwh - balance)
        }
        return LoadTimingAffordance(
            state: covered.map { .allowed($0.choice) } ?? .caution,
            periodName: active.name,
            balanceKwh: balance,
            choices: choices,
            nextUnmet: next,
            nextCheaper: timing.nextCheaper
        )
    }
}
