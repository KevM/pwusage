import SwiftUI

/// Start and end rows with no default. Opening a calendar doesn't choose a date: the owner taps
/// Use to set it. The end is an explicit choice of a date or Ongoing.
struct RatePlanDateChoiceSection: View {
    @Binding var start: Date?
    @Binding var end: RatePlanEnd?
    let timeZone: TimeZone
    var footer: String = "Use the dates on your utility bill. You can choose a date in the past."

    private enum EndKind: Hashable { case ongoing, date }
    @State private var wantsEndDate = false

    var body: some View {
        Section {
            OptionalRatePlanDateField(title: "Starts", date: $start, boundary: .first, timeZone: timeZone)
            Picker("Ends", selection: endKind) {
                Text("Choose").tag(EndKind?.none)
                Text("Ongoing").tag(EndKind?.some(.ongoing))
                Text("On a Date").tag(EndKind?.some(.date))
            }
            if endKind.wrappedValue == .date {
                OptionalRatePlanDateField(title: "End Date", date: endDate, boundary: .last, timeZone: timeZone)
            }
        } header: {
            Text("Effective Dates")
        } footer: {
            Text(footer)
        }
    }

    private var endKind: Binding<EndKind?> {
        Binding(
            get: {
                switch end {
                case .ongoing: .ongoing
                case .endsOn: .date
                case nil: wantsEndDate ? .date : nil
                }
            },
            set: { kind in
                wantsEndDate = kind == .date
                switch kind {
                case .ongoing: end = .ongoing
                case .date: if case .endsOn = end {} else { end = nil }
                case nil: end = nil
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
    let boundary: RatePlanTimelineFormatting.MonthBoundary?
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
            DatePicker(title, selection: $candidate, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .environment(\.timeZone, timeZone)
            Button("Use \(RatePlanTimelineFormatting.displayDate(candidateDay))") {
                date = candidate
                isChoosing = false
            }
            .fontWeight(.semibold)
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
