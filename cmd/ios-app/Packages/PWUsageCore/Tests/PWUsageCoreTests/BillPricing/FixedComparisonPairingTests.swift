import Foundation
@testable import PWUsageCore
import Testing

@Suite("FixedComparisonPairing")
struct FixedComparisonPairingTests {
    @Test
    func referenceCoveringPlanYieldsOneClippedRow() {
        let ref = Self.ref(1, from: "2023-01-01", through: "2026-12-31")
        let rows = FixedComparisonPairing.rows(for: (from: "2024-01-01", to: "2025-12-31"), references: [ref])
        #expect(rows == [FixedComparisonRow(from: "2024-01-01", to: "2025-12-31", reference: ref)])
    }

    @Test
    func revisionMidPlanSplitsOnRevisionDate() {
        let first = Self.ref(1, from: "2023-01-01", through: "2024-06-30")
        let second = Self.ref(2, from: "2024-07-01", through: nil)
        let rows = FixedComparisonPairing.rows(for: (from: "2024-01-01", to: "2025-12-31"), references: [first, second])
        #expect(rows == [
            FixedComparisonRow(from: "2024-01-01", to: "2024-06-30", reference: first),
            FixedComparisonRow(from: "2024-07-01", to: "2025-12-31", reference: second)
        ])
    }

    @Test
    func referenceStartingAfterPlanStartYieldsLeadingGapRow() {
        let ref = Self.ref(1, from: "2024-04-01", through: nil)
        let rows = FixedComparisonPairing.rows(for: (from: "2024-01-01", to: "2024-12-31"), references: [ref])
        #expect(rows == [
            FixedComparisonRow(from: "2024-01-01", to: "2024-03-31", reference: nil),
            FixedComparisonRow(from: "2024-04-01", to: "2024-12-31", reference: ref)
        ])
    }

    @Test
    func referenceEndingBeforePlanEndYieldsTrailingGapRow() {
        let ref = Self.ref(1, from: "2023-01-01", through: "2024-02-29")
        let rows = FixedComparisonPairing.rows(for: (from: "2024-01-01", to: "2024-12-31"), references: [ref])
        #expect(rows == [
            FixedComparisonRow(from: "2024-01-01", to: "2024-02-29", reference: ref),
            FixedComparisonRow(from: "2024-03-01", to: "2024-12-31", reference: nil)
        ])
    }

    @Test
    func uncoveredWholeSpanYieldsGapRow() {
        let rows = FixedComparisonPairing.rows(for: (from: "2024-01-01", to: "2024-12-31"), references: [])
        #expect(rows == [FixedComparisonRow(from: "2024-01-01", to: "2024-12-31", reference: nil)])
    }

    @Test
    func referenceOutsidePlanIsIgnored() {
        let old = Self.ref(1, from: "2020-01-01", through: "2023-12-31")
        let rows = FixedComparisonPairing.rows(for: (from: "2024-01-01", to: nil), references: [old])
        #expect(rows == [FixedComparisonRow(from: "2024-01-01", to: nil, reference: nil)])
    }

    @Test
    func openPlanWithOpenReferenceYieldsOpenRow() {
        let ref = Self.ref(1, from: "2023-01-01", through: nil)
        let rows = FixedComparisonPairing.rows(for: (from: "2024-01-01", to: nil), references: [ref])
        #expect(rows == [FixedComparisonRow(from: "2024-01-01", to: nil, reference: ref)])
    }

    @Test
    func unsortedReferencesYieldRowsOldestFirst() {
        let first = Self.ref(1, from: "2023-01-01", through: "2024-06-30")
        let second = Self.ref(2, from: "2024-07-01", through: nil)
        let rows = FixedComparisonPairing.rows(for: (from: "2024-01-01", to: nil), references: [second, first])
        #expect(rows.map(\.reference?.periodId) == [1, 2])
        #expect(rows.map(\.from) == ["2024-01-01", "2024-07-01"])
    }

    private static func ref(_ id: Int, from: String, through: String?) -> TariffPeriodDTO {
        TariffPeriodDTO(
            periodId: id,
            tariffId: id * 10,
            name: "Fixed \(id)",
            version: 1,
            source: .manual,
            effectiveFrom: from,
            effectiveTo: through,
            isCurrentToday: false,
            updatedBy: nil,
            seasons: []
        )
    }
}
