import SwiftUI

/// Season, sun-time and year scrubbers for inspecting shading, soiling and aging on the house model.
struct SolarSystemHealthControls: View {
    @Binding var state: SolarHouseHealthState
    let report: SolarHealthReport
    let overlay: SolarHouseHealthOverlay

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            seasonPicker
            sunTimeSlider
            if report.changeOverTime.years.count > 1 {
                yearSlider(years: report.changeOverTime.years)
            }
            if overlay.dirtAmount > 0, let loss = report.dirtLevel.currentLossPercent {
                let formatted = loss.formatted(.number.precision(.fractionLength(1)))
                Text("Soiling active · about \(formatted)% loss")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
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
