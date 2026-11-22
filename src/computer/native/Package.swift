// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AutomationHelper",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/openclaw/Peekaboo.git", revision: "69764083b16397845dc68b5c0ddb4f674290ae70"),
        .package(url: "https://github.com/openclaw/AXorcist.git", exact: "0.2.2"),
        .package(url: "https://github.com/apple/swift-algorithms", exact: "1.2.1"),
        .package(url: "https://github.com/apple/swift-log.git", exact: "1.15.1"),
        .package(url: "https://github.com/apple/swift-numerics.git", exact: "1.0.2"),
        .package(url: "https://github.com/steipete/Commander.git", exact: "0.3.0"),
        .package(url: "https://github.com/apple/swift-docc-plugin", exact: "1.4.0"),
        .package(url: "https://github.com/swiftlang/swift-docc-symbolkit", exact: "1.0.0"),
    ],
    targets: [
        .executableTarget(name: "AutomationHelper", dependencies: [
            .product(name: "PeekabooAutomationKit", package: "peekaboo"),
        ]),
    ],
    swiftLanguageModes: [.v6]
)
