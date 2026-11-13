import SwiftUI

/// Season, sun-time and year scrubbers for inspecting shading, soiling and aging on the house model.
struct SolarSystemHealthControls: View {
    @Binding var state: SolarHouseHealthState
    let report: SolarHealthReport
    let overlay: SolarHouseHealthOverlay
    var shadedMoment: (season: SolarSeason, hourOfDay: Double)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            statusSummaryRow
            seasonPicker
            sunTimeSlider
            if report.changeOverTime.years.count > 1 {
                yearSlider(years: report.changeOverTime.years)
            }
        }
        .padding(.vertical, 4)
    }

    private var statusSummaryRow: some View {
        HStack(spacing: 8) {
            shadingIndicator
            Spacer(minLength: 8)
            soilingIndicator
        }
        .font(.caption)
    }

    @ViewBuilder
    private var shadingIndicator: some View {
        if let moment = shadedMoment {
            Button {
                state.season = moment.season
                state.hourOfDay = moment.hourOfDay
            } label: {
                Label(
                    "Shaded · \(moment.season.capitalizedName) \(SolarHouseHealthOverlay.formatHour(moment.hourOfDay))",
                    systemImage: "cloud.sun.fill")
                    .foregroundStyle(Color.emphasis)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Jumps to a shaded time on the house")
        } else {
            Label("No shading", systemImage: "sun.max")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var soilingIndicator: some View {
        if report.dirtLevel.isActive {
            let detail = report.dirtLevel.currentLossPercent.map {
                "Soiling · about \($0.formatted(.number.precision(.fractionLength(1))))%"
            } ?? "Soiling active"
            Label(detail, systemImage: "aqi.medium")
                .foregroundStyle(Color.emphasis)
        } else {
            Label("Clean", systemImage: "sparkles")
                .foregroundStyle(.secondary)
        }
    }

    private var seasonPicker: some View {
        Picker("Season", selection: $state.season) {
            ForEach(SolarSeason.allCases, id: \.self) { season in
                Text(season.capitalizedName).tag(season)
            }
        }
        .pickerStyle(.segmented)
    }

    private var sunTimeSlider: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label("Sun", systemImage: overlay.isSunShaded ? "cloud.sun" : "sun.max")
                    .font(.subheadline)
                Spacer()
                Text(sunStatusText)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(overlay.isSunShaded ? Color.emphasis : .secondary)
            }
            Slider(value: $state.hourOfDay, in: 6 ... 20, step: 0.25) {
                Text("Time of day")
            }
        }
    }

    private var sunStatusText: String {
        let time = SolarHouseHealthOverlay.formatHour(state.hourOfDay)
        if overlay.sunElevation <= 0 {
            return "\(time) · Night"
        }
        if overlay.isSunShaded {
            return "\(time) · Shaded"
        }
        return time
    }

    private func yearSlider(years: [SolarHealthYearEntry]) -> some View {
        let selected = state.selectedYear ?? years.last?.year
        let currentIndex = years.firstIndex(where: { $0.year == selected }) ?? (years.count - 1)
        let entry = years[currentIndex]
        let percent = Int((entry.factor * 100).rounded())
        let indexBinding = Binding<Double>(
            get: { Double(currentIndex) },
            set: { newValue in
                let idx = min(max(Int(newValue.rounded()), 0), years.count - 1)
                state.selectedYear = years[idx].year
            })

        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Year")
                    .font(.subheadline)
                Spacer()
                Text("\(String(entry.year)) · \(percent)%")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Slider(value: indexBinding, in: 0 ... Double(years.count - 1), step: 1) {
                Text("Year")
            }
        }
    }
}
