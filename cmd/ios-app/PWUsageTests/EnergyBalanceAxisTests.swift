@testable import PWUsage
import Testing

struct EnergyBalanceAxisTests {
    @Test func anImportGapPlotsAboveZeroOnTheBillChart() {
        #expect(EnergyBalanceAxis.position(forNetGrid: 12.5) == 12.5)
    }

    @Test func anExportCushionPlotsBelowZeroOnTheBillChart() {
        #expect(EnergyBalanceAxis.position(forNetGrid: -12.5) == -12.5)
    }

    @Test func aBankPlotsBelowZeroOnTheSmartShiftChart() {
        #expect(EnergyBalanceAxis.position(forBank: 8) == -8)
    }

    @Test func anOwedBankPlotsAboveZeroOnTheSmartShiftChart() {
        #expect(EnergyBalanceAxis.position(forBank: -8) == 8)
    }

    @Test func theSmallerBankIsTheHigherLine() {
        #expect(EnergyBalanceAxis.plotsHigher(bank: 2, than: 10))
        #expect(!EnergyBalanceAxis.plotsHigher(bank: 10, than: 2))
    }

    @Test func equalBanksKeepTheFirstLineOnTop() {
        #expect(EnergyBalanceAxis.plotsHigher(bank: 5, than: 5))
    }
}
