import SwiftUI

/// What the tab bar's banner shows: the story of the Solar System screen in miniature.
struct SolarSystemBannerModel: Equatable {
    enum Mode: Equatable { case loading, needsLocation }

    static let dotCount = 12

    let mode: Mode
    let countText: String
    /// The newest stored days, oldest first, each in its pass color.
    let dots: [SiteHistoryStatus.Day]
    /// Waiting out a Tesla limit or a backoff: the dots stop and the compass dims.
    let isPaused: Bool
    let clearDays: Int
    let fittedRange: [Double]?
    let latitude: Double?
    let accessibilityLabel: String

    init(presentation: SiteHistoryPresentation, status: SiteHistoryStatus?) {
        mode = presentation.phase == .needsLocation ? .needsLocation : .loading
        countText = SiteHistoryPresentation.days(presentation.downloadedDays)
        dots = Array((status?.days ?? []).suffix(Self.dotCount))
        isPaused = presentation.phase == .waiting
        clearDays = presentation.clearDays
        if case .fitted(let range)? = status?.wedge { fittedRange = range } else { fittedRange = nil }
        latitude = status?.latitude
        accessibilityLabel = mode == .needsLocation
            ? "Add your location to find your solar system"
            : presentation.accessibilitySummary
    }
}

/// The tab bar's accessory while the solar system is being found: a tiny compass, the title and
/// day count, and a track where a dot arrives for each downloaded day. Inline it is just the
/// compass and the dots. Without a location it asks for one instead.
@available(iOS 26.0, *)
struct SolarSystemBanner: View {
    let model: SolarSystemBannerModel
    let onOpen: () -> Void
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                if model.mode == .needsLocation {
                    Image(systemName: "mappin.and.ellipse").foregroundStyle(SolarSystemColors.clear)
                    Text("Add your location to find your solar system")
                        .font(.subheadline)
                        .lineLimit(placement == .inline ? 1 : 2)
                        .minimumScaleFactor(0.85)
                } else {
                    SolarSystemMiniCompass(model: model).frame(width: 26, height: 26)
                    if placement != .inline {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(SiteHistoryPresentation.title).font(.subheadline.weight(.semibold))
                            Text(model.countText).font(.caption).foregroundStyle(.secondary)
                        }
                        .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    dotTrack
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
        .accessibilityHint("Opens Solar System in Settings")
        .accessibilityAddTraits(.isButton)
    }

    private var dotTrack: some View {
        HStack(spacing: 3) {
            ForEach(model.dots, id: \.day) { day in
                SolarSystemDayDot(type: day.type)
                    .transition(reduceMotion || model.isPaused
                        ? .identity : .move(edge: .trailing).combined(with: .opacity))
            }
        }
        .frame(height: 8)
        .animation(reduceMotion || model.isPaused ? nil : .spring(duration: 0.5), value: model.dots)
        .accessibilityHidden(true)
    }
}

/// One day: a filled dot in its pass color, or a faint dashed ring for no production.
struct SolarSystemDayDot: View {
    let type: SolarDayType?

    var body: some View {
        if type == .noProduction {
            Circle()
                .strokeBorder(SolarSystemColors.noProduction, style: StrokeStyle(lineWidth: 1, dash: [1.5, 1.5]))
                .frame(width: 6, height: 6)
        } else {
            Circle().fill(SolarSystemColors.color(type)).frame(width: 6, height: 6)
        }
    }
}

/// The banner's compass: a ring and the amber wedge, dimmed while paused.
struct SolarSystemMiniCompass: View {
    let model: SolarSystemBannerModel

    var body: some View {
        Canvas { context, size in
            let radius = min(size.width, size.height) / 2 - 1
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            func point(_ azimuth: Double, _ distance: Double) -> CGPoint {
                let radians = azimuth * .pi / 180
                return CGPoint(x: center.x + sin(radians) * distance * radius,
                               y: center.y - cos(radians) * distance * radius)
            }
            let width = SolarSystemWedge.width(clearDays: model.clearDays, fittedRange: model.fittedRange)
            let middle = SolarSystemWedge.center(fittedRange: model.fittedRange, latitude: model.latitude)
            var wedge = Path()
            wedge.move(to: center)
            wedge.addLines((0 ... 12).map { point(middle - width / 2 + width * Double($0) / 12, 0.95) })
            wedge.closeSubpath()
            context.fill(wedge, with: .color(SolarSystemColors.wedge.opacity(0.45)))
            context.stroke(Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius,
                                                  width: radius * 2, height: radius * 2)),
                           with: .color(SolarSystemColors.ring), lineWidth: 1.5)
        }
        .opacity(model.isPaused ? 0.45 : 1)
    }
}
