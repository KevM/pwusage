import CoreGraphics
@testable import PWUsage
import Testing

struct SmartShiftBarGeometryTests {
    private func bar(_ key: String = "test", baseline: Double, now: Double, later: Double) -> SmartShiftBar {
        let current = SmartShiftBarState(runKwh: now, totalPosition: baseline + now, runLabel: nil, total: "")
        let recommended = SmartShiftBarState(runKwh: later, totalPosition: baseline + later, runLabel: nil, total: "")
        return SmartShiftBar(periodKey: key, name: key, rate: "", buyRate: 1,
                             baselinePosition: baseline, recommended: recommended, now: current)
    }

    private func height(_ range: ClosedRange<CGFloat>) -> CGFloat { range.upperBound - range.lowerBound }

    /// The device screenshot's shape: On-Peak close to zero, Off-Peak hundreds of kWh away.
    private var nearZero: SmartShiftBar { bar("peak", baseline: -11, now: 40, later: 9) }
    private var farOwed: SmartShiftBar { bar("off", baseline: 371, now: 0, later: 31) }
    private var saving: SmartShiftSlot {
        SmartShiftSlot(periodKey: "off", extraKwh: 31, label: "Save $5.97", accessibilityLabel: "Save")
    }

    @Test func blockSpansBaselineAndTotal() {
        let value = bar(baseline: -10, now: 24, later: 6)
        let geometry = SmartShiftBarGeometry(bars: [value], slot: nil, plotHeight: 200)
        #expect(!geometry.isTorn(value))
        #expect(geometry.block(of: value, for: .now).contains(geometry.zeroY))
        #expect(geometry.block(of: value, for: .now).lowerBound == geometry.y(14, on: value))
        #expect(geometry.block(of: value, for: .now).upperBound == geometry.y(-10, on: value))
    }

    @Test func tinyRunKeepsAVisibleSliver() {
        let value = bar(baseline: 50, now: 0.1, later: 80)
        let geometry = SmartShiftBarGeometry(bars: [value], slot: nil, plotHeight: 200)
        let block = geometry.block(of: value, for: .now)
        #expect(height(block) >= 3)
        #expect(!geometry.labelFitsInside(value, for: .now))
    }

    @Test func smallSlotFitsAboveNowTotal() throws {
        let value = bar(baseline: 100, now: 1, later: 4)
        let slot = SmartShiftSlot(periodKey: "test", extraKwh: 3, label: "Save $1", accessibilityLabel: "Save")
        let geometry = SmartShiftBarGeometry(bars: [value], slot: slot, plotHeight: 200)
        let range = try #require(geometry.slot(on: value))
        #expect(range.upperBound == geometry.y(101, on: value))
        #expect(height(range) >= 22)
        #expect(range.lowerBound >= 0)
    }

    @Test func threeBarsFitAtPhoneWidth() {
        let width = SmartShiftBarGeometry.barWidth(count: 3, in: 280)
        #expect(width > 0 && width * 3 <= 280)
    }

    @Test func aBarFarFromZeroIsTornAndTheNearOneIsNot() throws {
        let geometry = SmartShiftBarGeometry(bars: [nearZero, farOwed], slot: saving, plotHeight: 240)
        #expect(!geometry.isTorn(nearZero))
        #expect(geometry.isTorn(farOwed))
        #expect(geometry.stump(of: nearZero) == nil)
        let stump = try #require(geometry.stump(of: farOwed))
        #expect(stump.upperBound == geometry.zeroY)
        let cutWidth = stump.lowerBound + SmartShiftBarGeometry.cutSlant - geometry.base(of: farOwed).upperBound
        #expect(cutWidth == SmartShiftBarGeometry.cutGap)
    }

    @Test func tornBarsKeepOneScaleSoBlocksCompare() {
        let geometry = SmartShiftBarGeometry(bars: [nearZero, farOwed], slot: saving, plotHeight: 240)
        let near = height(geometry.block(of: nearZero, for: .recommended))
        let far = height(geometry.block(of: farOwed, for: .recommended))
        #expect(abs(near / 9 - far / 31) < 0.001)
    }

    @Test func zoomMakesTheRunAndTheZeroCrossingReadable() {
        let geometry = SmartShiftBarGeometry(bars: [nearZero, farOwed], slot: saving, plotHeight: 240)
        #expect(height(geometry.block(of: farOwed, for: .recommended)) >= 80)
        #expect(height(geometry.block(of: nearZero, for: .recommended)) >= 20)
        #expect(geometry.block(of: nearZero, for: .now).contains(geometry.zeroY))
        #expect(geometry.labelFitsInside(farOwed, for: .recommended))
    }

    @Test func aFarBankStaysBelowZeroAfterTheRun() throws {
        let banked = bar("banked", baseline: -300, now: 40, later: 10)
        let geometry = SmartShiftBarGeometry(bars: [banked], slot: nil, plotHeight: 240)
        #expect(geometry.isTorn(banked))
        let stump = try #require(geometry.stump(of: banked))
        #expect(stump.lowerBound == geometry.zeroY)
        let cutWidth = geometry.base(of: banked).lowerBound + SmartShiftBarGeometry.cutSlant - stump.upperBound
        #expect(cutWidth == SmartShiftBarGeometry.cutGap)
        #expect(geometry.block(of: banked, for: .now).lowerBound > geometry.base(of: banked).lowerBound)
    }

    @Test func aSmallJobIsNotBlownUpToFillThePlot() {
        let peak = bar("peak", baseline: 62, now: 3, later: 0)
        let off = bar("off", baseline: 198, now: 0, later: 3)
        let geometry = SmartShiftBarGeometry(bars: [peak, off], slot: nil, plotHeight: 240)
        #expect(height(geometry.block(of: off, for: .recommended)) <= 24)
        #expect(geometry.height < 240)
    }

    @Test func noJobEnergyTearsNothing() {
        let idle = bar(baseline: 200, now: 0, later: 0)
        let geometry = SmartShiftBarGeometry(bars: [idle], slot: nil, plotHeight: 240)
        #expect(!geometry.isTorn(idle))
    }

    @Test(arguments: [
        [-11.0, 40, 9, 371, 0, 31],
        [62.0, 24, 0, 198, 16, 40],
        [62.0, 3, 0, 198, 0, 3],
        [-300.0, 40, 0, -5, 0, 40],
        [-80.0, 14, 0, -2, 0, 14]
    ])
    func everythingStaysInsideThePlot(values: [Double]) {
        let first = bar("first", baseline: values[0], now: values[1], later: values[2])
        let second = bar("second", baseline: values[3], now: values[4], later: values[5])
        let slot = SmartShiftSlot(periodKey: "second", extraKwh: values[5] - values[4],
                                  label: "Save", accessibilityLabel: "Save")
        let geometry = SmartShiftBarGeometry(bars: [first, second], slot: slot, plotHeight: 240)
        #expect(geometry.height <= 240)
        for value in [first, second] {
            for id in [SmartShiftChoiceID.now, .recommended] {
                let block = geometry.block(of: value, for: id)
                #expect(block.lowerBound >= 0 && block.upperBound <= geometry.height)
                #expect(geometry.totalLabelCenter(of: value, for: id, showsSlot: id == .now) >= 8)
            }
            #expect(geometry.base(of: value).upperBound <= geometry.height)
        }
    }

    @Test func totalsSitAboveTheSlotAndBanksAboveTheZeroLine() throws {
        let geometry = SmartShiftBarGeometry(bars: [nearZero, farOwed], slot: saving, plotHeight: 240)
        let slot = try #require(geometry.slot(on: farOwed))
        #expect(geometry.totalLabelCenter(of: farOwed, for: .now, showsSlot: true) < slot.lowerBound)
        #expect(geometry.totalLabelCenter(of: nearZero, for: .recommended, showsSlot: false) < geometry.zeroY)
    }
}
