#if DEBUG
    import SwiftUI

    /// Flows at each step of the guide, from the demo history, for previews.
    private enum RatePlanHistoryPreviewFlows {
        /// The demo history with a trusted Tesla start, so review shows the greyed Tesla row.
        static var history: RatePlanHistoryDTO {
            let demo = DemoFixtures.rateHistory(asOf: Date(timeIntervalSince1970: 1_800_000_000))
            return RatePlanHistoryDTO(
                utilityName: demo.utilityName, historyStart: demo.historyStart, fillThrough: "2026-04-27",
                teslaShape: demo.teslaShape, current: demo.current, years: demo.years
            )
        }

        /// The demo history with a second Fixed plan each year, so the plan list has two rows.
        static var historyWithTwoFixedPlans: RatePlanHistoryDTO {
            let base = history
            func extended(_ plans: [RatePlanHistoryPlanDTO]) -> [RatePlanHistoryPlanDTO] {
                plans + [RatePlanHistoryPlanDTO(
                    name: "Residential Fixed Plus (Single-Phase)", startDate: plans[0].startDate, kind: .fixed,
                    isDefault: false, closest: false, lowRate: 0.21, highRate: 0.21, peakWindows: [],
                    closestWindow: nil, fixedLabel: "demo-fixed-plus"
                )]
            }
            return RatePlanHistoryDTO(
                utilityName: base.utilityName, historyStart: base.historyStart, fillThrough: "2026-04-27",
                teslaShape: base.teslaShape, current: extended(base.current),
                years: base.years.map {
                    RatePlanHistoryYearDTO(year: $0.year, askDate: $0.askDate, plans: extended($0.plans))
                }
            )
        }

        static var start: RatePlanHistoryFlow {
            RatePlanHistoryFlow(history: history, hasTeslaPlan: true)
        }

        static var plan: RatePlanHistoryFlow {
            var flow = RatePlanHistoryFlow(history: historyWithTwoFixedPlans, hasTeslaPlan: true)
            flow.chooseKind(.fixed)
            return flow
        }

        static var hours: RatePlanHistoryFlow {
            var flow = start
            flow.chooseKind(.timeOfUse)
            return flow
        }

        static var sinceStart: RatePlanHistoryFlow {
            var flow = hours
            flow.choosePeakWindow(history.current[0].peakWindows[1])
            return flow
        }

        static var switchMonth: RatePlanHistoryFlow {
            var flow = sinceStart
            flow.answerSinceStart(false)
            return flow
        }

        static var olderKind: RatePlanHistoryFlow {
            var flow = switchMonth
            if let month = flow.defaultSwitchMonth() { flow.chooseSwitchMonth(month) }
            return flow
        }

        static var review: RatePlanHistoryFlow {
            var flow = olderKind
            flow.chooseKind(.fixed)
            flow.answerSinceStart(true)
            return flow
        }

        /// Review after a Still Not Sure answer: the whole walk is one assumed span.
        static var reviewAssumed: RatePlanHistoryFlow {
            var flow = hours
            flow.choosePeakWindow(history.current[0].peakWindows[1])
            flow.stillNotSure()
            flow.stillNotSure()
            flow.stillNotSure()
            return flow
        }
    }

    @MainActor
    private func previewStep(_ flow: RatePlanHistoryFlow) -> some View {
        let model = RatePlanHistoryModel(
            referencePeriods: [],
            loadHistory: { RatePlanHistoryPreviewFlows.history },
            saveHistory: { _ in }
        )
        return NavigationStack {
            RatePlanHistoryStepView(flow: flow, model: model, teslaPlanName: "CGS NM (edited)")
                .navigationTitle(RatePlanHistoryPresentation.navigationTitle(flow))
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    #Preview("Sheet, loading from demo") {
        RatePlanHistorySheet(
            teslaPlanName: "CGS NM (edited)",
            referencePeriods: [],
            load: { RatePlanHistoryPreviewFlows.history },
            save: { _ in }
        )
    }

    #Preview("Kind") { previewStep(RatePlanHistoryPreviewFlows.start) }
    #Preview("Plan") { previewStep(RatePlanHistoryPreviewFlows.plan) }
    #Preview("Peak hours") { previewStep(RatePlanHistoryPreviewFlows.hours) }
    #Preview("Since the start") { previewStep(RatePlanHistoryPreviewFlows.sinceStart) }
    #Preview("Switch month") { previewStep(RatePlanHistoryPreviewFlows.switchMonth) }
    #Preview("Plan before") { previewStep(RatePlanHistoryPreviewFlows.olderKind) }
    #Preview("Review") { previewStep(RatePlanHistoryPreviewFlows.review) }
    #Preview("Review, assumed") { previewStep(RatePlanHistoryPreviewFlows.reviewAssumed) }

    #Preview("Kind help") {
        RatePlanKindHelpSheet(
            utilityName: RatePlanHistoryPreviewFlows.history.utilityName,
            plans: RatePlanHistoryPreviewFlows.history.current,
            hasTeslaPlan: true
        ) {}
    }

    #Preview("Offer card") {
        RatePlanHistoryOfferCard(historyStart: "2023-11-14", onFind: {}, onNotNow: {})
            .padding()
    }
#endif
