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
            name: "PWUsageCore"
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
