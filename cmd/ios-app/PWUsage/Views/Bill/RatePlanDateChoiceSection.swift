import PWUsageCore
import SwiftUI

/// Start and end rows with no default. Opening a calendar doesn't choose a date: the owner taps
/// Use to set it. The end is an explicit choice of a date or Ongoing.
struct RatePlanDateChoiceSection: View {
    @Binding var start: Date?
    @Binding var end: RatePlanEnd?
    let timeZone: TimeZone
    var footer: String = "Use the dates on your utility bill. You can choose a date in the past."

    private enum EndChoice: Hashable { case unset, ongoing, date }
    @State private var wantsEndDate = false

    var body: some View {
        Section {
            OptionalRatePlanDateField(title: "Starts", date: $start, boundary: .first, timeZone: timeZone)
            Picker("Ends", selection: endChoice) {
                Text("Choose").tag(EndChoice.unset)
                Text("Ongoing").tag(EndChoice.ongoing)
                Text("On a Date").tag(EndChoice.date)
            }
            if endChoice.wrappedValue == .date {
                OptionalRatePlanDateField(title: "End Date", date: endDate, boundary: .last, timeZone: timeZone)
            }
        } header: {
            Text("Effective Dates")
        } footer: {
            Text(footer)
        }
    }

    private var endChoice: Binding<EndChoice> {
        Binding(
            get: {
                switch end {
                case .ongoing: .ongoing
                case .endsOn: .date
                case nil: wantsEndDate ? .date : .unset
                }
            },
            set: { choice in
                wantsEndDate = choice == .date
                switch choice {
                case .ongoing: end = .ongoing
                case .date: if case .endsOn = end {} else { end = nil }
                case .unset: end = nil
                }
            }
        )
    }

    private var endDate: Binding<Date?> {
        Binding(
            get: { if case .endsOn(let date) = end { date } else { nil } },
            set: { end = $0.map(RatePlanEnd.endsOn) }
        )
    }
}

/// A date row that stays unset until the owner explicitly uses a date.
struct OptionalRatePlanDateField: View {
    let title: LocalizedStringKey
    @Binding var date: Date?
    let boundary: RatePlanCalendarDays.MonthBoundary?
    let timeZone: TimeZone
    @State private var isChoosing = false
    @State private var candidate = Date()

    var body: some View {
        if let current = date {
            RatePlanDateField(
                title: title,
                date: Binding(get: { current }, set: { date = $0 }),
                boundary: boundary,
                timeZone: timeZone
            )
        } else if isChoosing {
            LabeledContent(title) {
                Text("Tap Use to confirm")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            DatePicker(title, selection: $candidate, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .environment(\.timeZone, timeZone)
            Button {
                date = candidate
                isChoosing = false
            } label: {
                Text("Use \(RatePlanTimelineFormatting.displayDate(candidateDay))")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .emphasisProminentButton()
        } else {
            LabeledContent(title) {
                Button("Choose Date") { isChoosing = true }
            }
        }
    }

    private var candidateDay: String {
        RatePlanTimelineFormatting.formatYMD(candidate, in: timeZone)
    }
}
