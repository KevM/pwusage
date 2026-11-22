import Foundation
import Observation
import PWUsageCore

/// One country the owner can choose for their site.
struct SiteCountryOption: Equatable, Identifiable, Sendable {
    /// ISO 3166-1 alpha-2.
    let code: String
    let name: String
    var id: String { code }

    init(code: String, locale: Locale = .current) {
        self.code = code
        name = locale.localizedString(forRegionCode: code) ?? code
    }
}

/// The owner's explicit choice of site country, used when the saved home location can't settle
/// it. Suggestions come from that location, worked out on the device; the choice always wins.
@MainActor
@Observable
final class SiteCountryPickerModel {
    enum Outcome: Equatable {
        /// Public utility plans apply: continue to the utility picker.
        case publicPlansAvailable
        case done
    }

    private(set) var suggestions: [SiteCountryOption] = []
    private(set) var savingCode: String?
    private(set) var errorMessage: String?
    private(set) var outcome: Outcome?
    var query = ""

    @ObservationIgnored private let inference: @MainActor () async -> SiteCountryInference
    @ObservationIgnored private let save: @MainActor (String) async throws -> SiteTariffsTimelineResponse
    @ObservationIgnored private let locale: Locale

    init(
        inference: @escaping @MainActor () async -> SiteCountryInference,
        save: @escaping @MainActor (String) async throws -> SiteTariffsTimelineResponse,
        locale: Locale = .current
    ) {
        self.inference = inference
        self.save = save
        self.locale = locale
    }

    var isSaving: Bool { savingCode != nil }

    /// Every ISO country, sorted by name, narrowed by the search query.
    var countries: [SiteCountryOption] {
        let all = Locale.Region.isoRegions
            .map(\.identifier)
            .filter { $0.count == 2 && $0.allSatisfy(\.isUppercase) }
            .map { SiteCountryOption(code: $0, locale: locale) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return all }
        return all.filter {
            $0.name.localizedStandardContains(trimmed) || $0.code.caseInsensitiveCompare(trimmed) == .orderedSame
        }
    }

    func load() async {
        let codes: [String] = switch await inference() {
        case .nearBorder(let candidates): candidates
        case .resolved(let code): [code]
        case .unresolved, .noLocation: []
        }
        suggestions = codes.map { SiteCountryOption(code: $0, locale: locale) }
    }

    func select(_ option: SiteCountryOption) async {
        guard !isSaving else { return }
        savingCode = option.code
        errorMessage = nil
        defer { savingCode = nil }
        do {
            let timeline = try await save(option.code)
            // A newly confirmed US site may still be pending utility discovery; continue to the
            // utility picker whenever no utility is chosen yet.
            let isUS = timeline.rateCountry?.eligibility == .unitedStates
            let hasUtility = !(timeline.estimates?.utilityName ?? "").isEmpty
            outcome = isUS && !hasUtility ? .publicPlansAvailable : .done
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
