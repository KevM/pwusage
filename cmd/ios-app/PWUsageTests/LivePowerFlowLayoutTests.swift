import SwiftUI
import Testing
@testable import PWUsage

@Suite("Live Power Flow Layout Tests")
@MainActor
struct LivePowerFlowLayoutTests {
    private func flow(solar: Double, home: Double, grid: Double, battery: Double) -> DashboardPresentation.PowerFlow {
        DashboardPresentation.powerFlow(
            solarPower: solar, loadPower: home, batteryPower: battery, gridPower: grid,
            sourceTime: .now, isUnavailable: false
        )
    }

    @Test("Idle cards keep common flow scenarios compact; narrow and accessibility layouts expand")
    func compactAndAdaptiveLayouts() throws {
        let scenarios: [(String, DashboardPresentation.PowerFlow)] = [
            ("solar-battery", flow(solar: 754, home: 1064, grid: 0, battery: 310)),
            ("grid-charging", flow(solar: 0, home: 1000, grid: 3000, battery: -2000)),
            ("night", flow(solar: 0, home: 1000, grid: 0, battery: 1000))
        ]
        for (name, flow) in scenarios {
            let compact = try render(flow, width: 330, typeSize: .large, name: name)
            #expect(compact.height < 300)
            let narrow = try render(flow, width: 250, typeSize: .large, name: name + "-narrow")
            #expect(narrow.height > compact.height)
            let accessible = try render(flow, width: 330, typeSize: .accessibility2, name: name + "-accessibility")
            #expect(accessible.height > narrow.height)
        }
    }

    private func render(_ flow: DashboardPresentation.PowerFlow, width: CGFloat,
                        typeSize: DynamicTypeSize, name: String) throws -> CGSize {
        let renderer = ImageRenderer(content: LivePowerFlowCards(flow: flow)
            .environment(\.dynamicTypeSize, typeSize)
            .frame(width: width)
            .padding(16)
            .background(Color(uiColor: .secondarySystemGroupedBackground)))
        let image = try #require(renderer.uiImage)
        let data = try #require(image.pngData())
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("power-flow-\(name).png")
        try data.write(to: output)
        print("Power flow render: \(output.path)")
        return image.size
    }
}
