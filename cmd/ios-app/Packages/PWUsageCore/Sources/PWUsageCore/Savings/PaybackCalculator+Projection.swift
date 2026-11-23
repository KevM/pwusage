import Foundation

/// Forward projection for payback: each future billing cycle's savings, grown with rates and aging.
extension PaybackContext {
    /// Site-local first of the month in which a billing cycle closes. The cycle's last second decides the month.
    func billingMonth(closedAt end: Date) -> Date {
        monthStart(of: end.addingTimeInterval(-1))
    }

    /// First future cycle whose paid-to-date plus projected savings reaches the net cost, within the horizon.
    /// Cycle k closes k + 1 calendar months after the current cycle's month and takes that month's base.
    func projectedMonth(_ streams: [PaybackStream], netCost: Double, paid: Double) -> Date? {
        guard let current = report.recentCycles.last else { return nil }
        let currentMonth = billingMonth(closedAt: current.end)
        let bases = streams.map { monthlyBase(for: $0) }
        var cumulative = paid
        for index in 0 ..< PaybackCalculator.horizonCycles {
            let month = calendar.date(byAdding: .month, value: index + 1, to: currentMonth) ?? currentMonth
            let slot = calendar.component(.month, from: month) - 1
            let years = Double(index + 1) / Double(PaybackCalculator.cyclesPerYear)
            var cycleSavings = 0.0
            for (stream, base) in zip(streams, bases) {
                cycleSavings += base[slot] * growth(of: stream, years: years)
            }
            cumulative += cycleSavings
            if cumulative >= netCost {
                return month
            }
        }
        return nil
    }

    /// One full-cycle base per calendar month, January first, from the last 12 cycles. A month the window
    /// has no cycle for (a shorter history or a billing-day change) takes the mean of the months it has, so
    /// a short history never shifts the seasons.
    func monthlyBase(for stream: PaybackStream) -> [Double] {
        var slots = [Double?](repeating: nil, count: PaybackCalculator.cyclesPerYear)
        for (cycle, value) in zip(report.recentCycles, baseSavings(for: stream)) {
            slots[calendar.component(.month, from: billingMonth(closedAt: cycle.end)) - 1] = value
        }
        let known = slots.compactMap(\.self)
        let fill = known.isEmpty ? 0 : known.reduce(0, +) / Double(known.count)
        return slots.map { $0 ?? fill }
    }

    /// The last 12 cycles' savings for one stream, each scaled to a full cycle, oldest first.
    /// Cycles before the stream's start and cycles with no counted days take the mean daily savings of the
    /// stream's counted cycles, times their length. With no counted day since the start (a start after the
    /// last synced day), the whole window's history is the base instead.
    func baseSavings(for stream: PaybackStream) -> [Double] {
        let cycles = report.recentCycles
        let postStart = cycles.filter { $0.end > stream.start }
        let usesStart = postStart.contains { $0.daysWithData > 0 }
        let counted = usesStart ? postStart : cycles
        let countedDays = counted.reduce(0) { $0 + $1.daysWithData }
        let countedSavings = counted.reduce(0.0) { $0 + stream.component.savings($1.costs) }
        let meanDaily = countedDays > 0 ? countedSavings / Double(countedDays) : 0
        return cycles.map { cycle in
            guard !usesStart || cycle.end > stream.start, cycle.daysWithData > 0 else {
                return meanDaily * Double(cycle.daysInCycle)
            }
            let savings = stream.component.savings(cycle.costs)
            return savings * Double(cycle.daysInCycle) / Double(cycle.daysWithData)
        }
    }

    /// The rate and aging factor for a stream `years` from now. Solar output declines; Powerwall capacity fades.
    func growth(of stream: PaybackStream, years: Double) -> Double {
        let rates = pow(1 + assumptions.rateGrowth.annualRate, years)
        switch stream.component {
        case .solar:
            return rates * pow(1 - assumptions.solarDecline, years)
        case .powerwall:
            let today = batteryCapacity(atAge: stream.ageYears)
            return rates * batteryCapacity(atAge: stream.ageYears + years) / today
        }
    }

    /// Share of nameplate energy left at an age, linear from Tesla's warranty: 70% at 10 years, never below 30%.
    func batteryCapacity(atAge years: Double) -> Double {
        max(0.3, 1 - PaybackCalculator.batteryFadePerYear * years)
    }

    private func monthStart(of date: Date) -> Date {
        calendar.date(from: calendar.dateComponents([.year, .month], from: date)) ?? date
    }
}
