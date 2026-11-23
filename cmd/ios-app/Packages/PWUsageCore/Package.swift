// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PWUsageCore",
    platforms: [
        .iOS(.v18),
        .macOS(.v15)
    ],
    products: [
        .library(
            name: "PWUsageCore",
            targets: ["PWUsageCore"]
        )
    ],
    targets: [
        .target(
            name: "PWUsageCore",
            // Each domain folder's README guides contributors; list a new domain's here too.
            exclude: [
                "BatteryHold/README.md",
                "BillPricing/README.md",
                "LoadTiming/README.md",
                "Savings/README.md",
                "SharedModels/README.md",
                "SiteCountry/README.md",
                "SolarForecast/README.md",
                "SolarHealth/README.md",
                "SolarLayout/README.md"
            ]
        ),
        .testTarget(
            name: "PWUsageCoreTests",
            dependencies: ["PWUsageCore"],
            resources: [
                .copy("Fixtures")
            ]
        )
    ]
)
