// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "swift-grab-capture",
    platforms: [
        // ScreenCaptureKit needs 12.3+, modern async variants settle around 14.
        .macOS(.v14),
    ],
    products: [
        .executable(name: "swift-grab-capture", targets: ["swift-grab-capture"]),
    ],
    targets: [
        .executableTarget(
            name: "swift-grab-capture",
            path: "Sources/swift-grab-capture"
        ),
    ]
)
