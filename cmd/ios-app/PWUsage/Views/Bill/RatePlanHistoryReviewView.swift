import SwiftUI

/// The last step: every span the walk filled in, newest first, behind the greyed Tesla row. Change
/// reopens that answer; Save Rate Plans writes the periods.
struct RatePlanHistoryReviewView: View {
    let flow: RatePlanHistoryFlow
    let model: RatePlanHistoryModel
    let teslaRow: RatePlanHistoryPresentation.TeslaRow?

    var body: some View {
        HistoryStepFrame(title: RatePlanHistoryPresentation.question(flow)) {
            VStack(spacing: 0) {
                if let teslaRow {
                    timelineRow(isLast: shown.isEmpty, dot: Color.secondary) { teslaCard(teslaRow) }
                }
                ForEach(Array(shown.enumerated()), id: \.element.index) { position, item in
                    timelineRow(isLast: position == shown.count - 1, dot: Color.emphasis) {
                        spanCard(item.span, index: item.index)
                    }
                }
            }
            Text(RatePlanHistoryPresentation.reviewFooter)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
        } footer: {
            if let message = model.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ProminentActionButton(
                title: RatePlanHistoryPresentation.saveTitle,
                busyTitle: RatePlanHistoryPresentation.savingTitle,
                isBusy: model.isSaving
            ) {
                Task { await model.save() }
            }
            .font(.headline)
            .controlSize(.large)
        }
    }

    private var shown: [(index: Int, span: RatePlanHistoryFlow.Span)] {
        flow.reviewSpans
    }

    private func timelineRow(
        isLast: Bool,
        dot: Color,
        @ViewBuilder card: () -> some View
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 4) {
                Circle().fill(dot).frame(width: 12, height: 12).padding(.top, 20)
                Rectangle()
                    .fill(isLast ? Color.clear : Color.secondary.opacity(0.35))
                    .frame(width: 2)
            }
            .frame(width: 14)
            .accessibilityHidden(true)
            card().padding(.bottom, isLast ? 0 : 10)
        }
    }

    private func teslaCard(_ row: RatePlanHistoryPresentation.TeslaRow) -> some View {
        CardContainer(padding: 15, cornerRadius: 16, spacing: 6) {
            Text(row.name).font(.headline)
            Text(row.range).font(.subheadline)
            Text(RatePlanHistoryPresentation.teslaRowCaption).font(.footnote)
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    private func spanCard(_ span: RatePlanHistoryFlow.Span, index: Int) -> some View {
        CardContainer(padding: 15, cornerRadius: 16, spacing: 6) {
            VStack(alignment: .leading, spacing: 6) {
                if span.assumed {
                    HistoryPill(text: RatePlanHistoryPresentation.assumedPill, tint: .orange)
                }
                Text(RatePlanHistoryPresentation.spanTitle(span)).font(.headline)
                Text(RatePlanHistoryPresentation.spanRange(span)).font(.subheadline)
            }
            .accessibilityElement(children: .combine)
            Button(RatePlanHistoryPresentation.changeTitle) {
                model.update { $0.reopenSpan(at: index) }
            }
            .font(.subheadline)
        }
    }
}
