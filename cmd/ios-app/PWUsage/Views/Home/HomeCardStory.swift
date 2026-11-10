import SwiftUI

/// A Home card that is waiting or has failed. It draws `placeholder` invisibly so
/// it takes exactly the loaded card's size, and tells its story on top.
struct HomeWaitingCard<Placeholder: View>: View {
    let card: HomeCard
    let phase: (Date) -> HomeCardPhase
    var theme: SectionTheme?
    @ViewBuilder let placeholder: Placeholder

    var body: some View {
        StatusCard(theme: theme) {
            placeholder
                .opacity(0)
                .accessibilityHidden(true)
                .overlay { HomeCardStory(card: card, phase: phase) }
        }
    }
}

/// An animated SF Symbol and a rotating line about what the card is fetching.
/// After 10 seconds the line says it is slow; on failure the symbol breaks and
/// the card asks for a pull to refresh.
struct HomeCardStory: View {
    let card: HomeCard
    let phase: (Date) -> HomeCardPhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: HomeLoadingPresentation.lineInterval / 2)) { context in
            // A resumed timeline can deliver a past date; the real clock decides.
            let now = max(context.date, .now)
            story(phase: phase(now), now: now)
        }
    }

    private func story(phase: HomeCardPhase, now: Date) -> some View {
        let isBroken = phase == .broken
        let line = HomeLoadingPresentation.line(for: card, phase: phase, now: now)
        return HStack(spacing: 12) {
            symbol(isBroken: isBroken)
            VStack(alignment: .leading, spacing: 2) {
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .contentTransition(.opacity)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.4), value: line)
                if isBroken {
                    Text(HomeLoadingPresentation.retryHint)
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(HomeLoadingPresentation.accessibilityLabel(for: card, phase: phase))
    }

    private func symbol(isBroken: Bool) -> some View {
        let animates = !reduceMotion && !isBroken
        return Image(systemName: isBroken ? card.brokenSymbol : card.waitingSymbol)
            .font(.title2)
            .foregroundStyle(isBroken ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
            .symbolEffect(.variableColor.iterative, options: .repeating,
                          isActive: animates && card.usesVariableColor)
            .symbolEffect(.breathe, options: .repeating, isActive: animates && !card.usesVariableColor)
            .contentTransition(.symbolEffect(.replace))
            .animation(reduceMotion ? nil : .default, value: isBroken)
            .frame(width: 32)
    }
}
