// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "sim-grab-capture",
    platforms: [
        // ScreenCaptureKit needs 12.3+, modern async variants settle around 14.
        .macOS(.v14),
    ],
    products: [
        .executable(name: "sim-grab-capture", targets: ["sim-grab-capture"]),
    ],
    targets: [
        .executableTarget(
            name: "sim-grab-capture",
            path: "Sources/sim-grab-capture"
        ),
    ]
)
